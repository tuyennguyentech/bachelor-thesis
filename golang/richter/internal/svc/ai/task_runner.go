package ai

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"
)

// svcParseUUIDStr is a thin wrapper that converts the string ID stored in
// FDB to a pgtype.UUID for the existing helpers in the ai package.
func svcParseUUIDStr(value string) (pgtype.UUID, error) {
	return svc.ParseUUID(value)
}

// StartTaskRunner launches the worker pool. The pool size and per-user cap
// come from cfg.LessonTaskCfg. Each worker shares the same taskNotify channel
// so Enqueue wakes exactly one waiter (non-blocking).
//
// The function does not block; the worker goroutines run until ctx is done.
func StartTaskRunner(s *AISvc, l *log.LogSvc, store *LessonTaskStore) {
	workerCount := s.taskStore.taskCfg.Workers
	if workerCount <= 0 {
		// 0 = auto = NumCPU. Whisper transcription is the dominant cost
		// and is CPU-bound, so Go's standard "one worker per core" rule
		// of thumb applies. Operators can pin a specific value via config.
		workerCount = runtime.NumCPU()
	}
	if workerCount < 1 {
		workerCount = 1
	}
	ctx := context.Background()

	// Best-effort stale recovery on startup. Failure is logged, not fatal:
	// every worker tick also re-claims and the worst case is that an old task
	// is queued twice (the second claim finds it terminal and skips).
	go func() {
		if reclaimed, err := store.ReclaimStale(ctx); err != nil {
			l.WarnContext(ctx, "ai: stale task reclaim failed", "err", err)
		} else if len(reclaimed) > 0 {
			l.InfoContext(ctx, "ai: reclaimed stale tasks", "count", len(reclaimed))
		}
	}()

	for i := 0; i < workerCount; i++ {
		go s.lessonTaskWorker(ctx, i, store)
	}
}

func (s *AISvc) lessonTaskWorker(ctx context.Context, workerID int, store *LessonTaskStore) {
	pollInterval := store.taskCfg.PollInterval
	if pollInterval < 0 {
		pollInterval = 0
	}
	staleCheckInterval := store.taskCfg.StaleCheckInterval
	if staleCheckInterval < 0 {
		staleCheckInterval = 0
	}
	staleCheckAt := time.Now().Add(staleCheckInterval)
	for {
		ran, err := s.claimAndRunLessonTask(ctx, store)
		if err != nil {
			s.log.ErrorContext(ctx, "ai task worker failed", "worker_id", workerID, "err", err)
		}
		if ran {
			continue
		}
		// Periodic stale check. Skipped when staleCheckInterval is 0 (disabled).
		if staleCheckInterval > 0 && time.Now().After(staleCheckAt) {
			if reclaimed, rerr := store.ReclaimStale(ctx); rerr != nil {
				s.log.WarnContext(ctx, "ai: stale task reclaim failed", "err", rerr)
			} else if len(reclaimed) > 0 {
				s.log.InfoContext(ctx, "ai: reclaimed stale tasks", "count", len(reclaimed))
			}
			staleCheckAt = time.Now().Add(staleCheckInterval)
		}
		select {
		case <-ctx.Done():
			return
		case <-s.taskNotify:
		case <-time.After(pollInterval):
		}
	}
}

func (s *AISvc) claimAndRunLessonTask(ctx context.Context, store *LessonTaskStore) (bool, error) {
	taskID, err := store.ClaimAndPop(ctx)
	if err != nil {
		if errors.Is(err, errQueueEmpty) {
			return false, nil
		}
		return false, err
	}
	if _, err := store.MarkRunning(ctx, taskID); err != nil {
		s.log.WarnContext(ctx, "ai: failed to mark task running", "task_id", taskID, "err", err)
	}

	rec, err := store.Get(ctx, taskID)
	if err != nil {
		s.log.WarnContext(ctx, "ai: claimed task but cannot load it", "task_id", taskID, "err", err)
		return true, nil
	}

	// Per-task cancel func held on the worker goroutine. Cancel is observed
	// by reading cancel_signal/<id> on each progress tick (see runWithCancel).
	taskCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	runErr := s.runClaimedLessonTask(taskCtx, rec, cancel)
	if errors.Is(runErr, errTaskCanceled) {
		// Cancel was observed. Cancel RPC has already written CANCELED;
		// nothing more to do.
		return true, nil
	}
	if runErr != nil {
		if _, mErr := store.MarkFailed(ctx, taskID, "Tác vụ thất bại.", runErr.Error()); mErr != nil {
			s.log.ErrorContext(ctx, "ai: failed to mark task failed", "task_id", taskID, "err", mErr)
		}
		return true, nil
	}
	if _, err := store.MarkSucceeded(ctx, taskID, "Tác vụ đã hoàn tất."); err != nil {
		s.log.ErrorContext(ctx, "ai: failed to mark task succeeded", "task_id", taskID, "err", err)
	}
	return true, nil
}

// errTaskCanceled is the sentinel returned by runClaimedLessonTask when the
// task was cancelled. Other errors are real failures.
var errTaskCanceled = errors.New("ai: task was cancelled")

// runClaimedLessonTask dispatches based on Kind. The cancel func is called
// by the per-task progress sink when it observes cancel_signal in FDB.
func (s *AISvc) runClaimedLessonTask(
	ctx context.Context,
	rec lessonTaskRecord,
	cancel context.CancelFunc,
) error {
	// Wrap each progress callback to also poll cancel_signal/<id>. The poll
	// runs synchronously inside the callback so it cannot race with the
	// handler's own progress emission.
	progressFn := func(step string, current, total int32, msg string) error {
		return s.tickProgress(ctx, rec.ID, step, current, total, msg, cancel)
	}

	genProgressFn := func(step string, msg string, chunkIndex, totalChunks int32) error {
		return s.tickProgress(ctx, rec.ID, step, chunkIndex, totalChunks, msg, cancel)
	}

	switch rec.Kind {
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT:
		lessonID, videoKey, err := s.lessonVideoKeyForTask(ctx, rec.LessonID)
		if err != nil {
			return err
		}
		return s.runExtractTranscript(ctx, lessonID, videoKey, func(step richterv1.AnalysisProgressStep, msg string) error {
			current, total := analysisStepCurrent(step), int32(4)
			return progressFn(step.String(), current, total, msg)
		})
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_CHUNK_TRANSCRIPT:
		lessonID, err := svcParseUUIDStr(rec.LessonID)
		if err != nil {
			return err
		}
		return s.runChunkTranscript(ctx, lessonID, func(step richterv1.AnalysisProgressStep, msg string) error {
			current, total := chunkStepCurrent(step), int32(2)
			return progressFn(step.String(), current, total, msg)
		})
	case richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS:
		req := &richterv1.GenerateInteractionsRequest{}
		if len(rec.RequestPayload) > 0 {
			if err := proto.Unmarshal(rec.RequestPayload, req); err != nil {
				return fmt.Errorf("parse generation task request: %w", err)
			}
		}
		if req.LessonId == "" {
			req.LessonId = rec.LessonID
		}
		lessonID, err := svcParseUUIDStr(rec.LessonID)
		if err != nil {
			return err
		}
		return s.runGenerateInteractions(ctx, lessonID, req, func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error {
			return genProgressFn(step.String(), msg, chunkIndex, totalChunks)
		})
	default:
		return fmt.Errorf("ai: unsupported task kind: %s", rec.Kind)
	}
}

// tickProgress writes a progress update and observes cancel_signal/<id>.
// If the cancel signal is present it invokes the local cancel func and
// returns a sentinel that the worker recognizes as cancellation.
func (s *AISvc) tickProgress(
	ctx context.Context,
	taskID, step string,
	current, total int32,
	message string,
	cancel context.CancelFunc,
) error {
	if present, err := s.taskStore.CancelSignalPresent(ctx, taskID); err != nil {
		// Treat transient read errors as "no cancel" so the worker doesn't
		// false-positive on FDB hiccups. The next tick will retry.
		s.log.WarnContext(ctx, "ai: failed to read cancel signal", "task_id", taskID, "err", err)
	} else if present {
		cancel()
		return errTaskCanceled
	}
	if err := s.taskStore.UpdateProgress(ctx, taskID, step, current, total, message); err != nil {
		s.log.WarnContext(ctx, "ai: failed to write progress", "task_id", taskID, "err", err)
	}
	return nil
}

// lessonVideoKeyForTask loads the lesson and returns its video storage key.
func (s *AISvc) lessonVideoKeyForTask(ctx context.Context, lessonIDStr string) (pgtype.UUID, string, error) {
	lessonID, err := svcParseUUIDStr(lessonIDStr)
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	video, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	if !video.VideoStorageKey.Valid || video.VideoStorageKey.String == "" {
		return pgtype.UUID{}, "", fmt.Errorf("lesson has no video uploaded")
	}
	return lessonID, video.VideoStorageKey.String, nil
}

// analysisStepCurrent maps a step to a 1..4 ordinal for the progress counter.
func analysisStepCurrent(step richterv1.AnalysisProgressStep) int32 {
	switch step {
	case richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DOWNLOADING:
		return 1
	case richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UPLOADING:
		return 2
	case richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING:
		return 3
	case richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING:
		return 4
	default:
		return 0
	}
}

func chunkStepCurrent(step richterv1.AnalysisProgressStep) int32 {
	switch step {
	case richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING:
		return 1
	case richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING:
		return 2
	default:
		return analysisStepCurrent(step)
	}
}
