package ai

import (
	"context"
	"errors"
	"fmt"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal/kv"
	fdb "github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/google/uuid"
	"github.com/samber/do/v2"
)

var (
	errTaskNotFound      = errors.New("ai: task not found")
	errQueueEmpty        = errors.New("ai: task queue is empty")
	errResourceExhausted = errors.New("ai: per-user task cap reached")
)

// LessonTaskStore is a FoundationDB-backed durable queue of long-running
// AI tasks. It exposes the only API the AI service uses to interact with
// tasks: create, list, get, cancel, claim-and-pop. Internal helpers are
// package-private.
type LessonTaskStore struct {
	kv      *kv.KVSvc
	taskCfg *cfg.LessonTaskCfg
}

// NewLessonTaskStore builds a store from the injected KVSvc and config.
func NewLessonTaskStore(i do.Injector) (*LessonTaskStore, error) {
	k, err := do.Invoke[*kv.KVSvc](i)
	if err != nil {
		return nil, fmt.Errorf("KVSvc: %w", err)
	}
	c, err := do.Invoke[*cfg.LessonTaskCfg](i)
	if err != nil {
		return nil, fmt.Errorf("LessonTaskCfg: %w", err)
	}
	return &LessonTaskStore{kv: k, taskCfg: c}, nil
}

// CreateLessonTaskInput is the parameter for Enqueue. The store is responsible
// for assigning the ID and timestamps; the caller provides the business data.
type CreateLessonTaskInput struct {
	LessonID       string
	ChunkID        string
	Kind           richterv1.LessonTaskKind
	RequestPayload []byte
	CreatedBy      string
	Message        string
}

// Enqueue atomically:
//  1. Checks active_target for an existing (lesson, kind, chunk) record.
//     If present, returns the existing task (active uniqueness invariant).
//  2. Enforces MaxActivePerUser via by_user/<id>/active prefix count.
//  3. Creates a fresh task with status=QUEUED and inserts:
//     - r/<id>                       → FdbLessonTaskRecord (protobuf)
//     - queue/<seq>/<rnd>            → <id>
//     - by_lesson/<id>/all/<ts>/<id> → ""
//     - by_lesson/<id>/active/<ts>/<id> → ""
//     - by_user/<user>/active/<ts>/<id> → ""
//     - active_target/<id>/<kind>/<chunk>/<id> → ""
//
// Returns the freshly created or existing-active task.
func (s *LessonTaskStore) Enqueue(
	ctx context.Context,
	in CreateLessonTaskInput,
) (lessonTaskRecord, error) {
	if in.CreatedBy == "" {
		return lessonTaskRecord{}, fmt.Errorf("ai: CreatedBy is required")
	}
	if in.Message == "" {
		in.Message = "Đã đưa tác vụ vào hàng đợi."
	}

	// 1. Per-user cap. Read happens OUTSIDE the Enqueue transaction to avoid
	// a self-conflict on the by_user range and (more importantly) to avoid
	// a deadlock from nested Transact calls. Tiny race window is accepted:
	// under heavy burst the cap may be exceeded by at most 1.
	activeCount, err := s.countActiveByUser(in.CreatedBy)
	if err != nil {
		return lessonTaskRecord{}, err
	}
	if activeCount >= s.taskCfg.MaxActivePerUser {
		return lessonTaskRecord{}, errResourceExhausted
	}

	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		// 2. Active uniqueness check.
		atKey := taskActiveTargetKey(in.LessonID, in.Kind, in.ChunkID)
		existing := tr.Get(atKey).MustGet()
		if existing != nil {
			taskID := string(existing)
			rec, ok, readErr := readTaskRecordInTx(tr, taskID)
			if readErr != nil {
				return lessonTaskRecord{}, readErr
			}
			if !ok {
				// Stale index — clean it up and proceed.
				tr.Clear(atKey)
			} else {
				return rec, nil
			}
		}

		// 3. Allocate seq. Snapshot read of the queue tail.
		seq, err := s.lastQueueSeqInTx(tr)
		if err != nil {
			return lessonTaskRecord{}, err
		}
		seq++

		now := time.Now().UTC()
		rec := lessonTaskRecord{
			ID:             uuid.NewString(),
			LessonID:       in.LessonID,
			ChunkID:        in.ChunkID,
			Kind:           in.Kind,
			Status:         richterv1.LessonTaskStatus_LESSON_TASK_STATUS_QUEUED,
			Message:        in.Message,
			RequestPayload: in.RequestPayload,
			CreatedBy:      in.CreatedBy,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		recBytes, marshalErr := marshalLessonTaskRecord(rec)
		if marshalErr != nil {
			return lessonTaskRecord{}, marshalErr
		}

		tr.Set(taskRecordKey(rec.ID), recBytes)
		tr.Set(taskQueueKey(seq), []byte(rec.ID))
		tr.Set(taskByLessonKey(in.LessonID, "all", now, rec.ID), []byte{})
		tr.Set(taskByLessonKey(in.LessonID, "active", now, rec.ID), []byte{})
		tr.Set(taskByUserKey(in.CreatedBy, "active", now, rec.ID), []byte{})
		tr.Set(taskActiveTargetKey(in.LessonID, in.Kind, in.ChunkID), []byte(rec.ID))

		return rec, nil
	})
	if err != nil {
		if errors.Is(err, errResourceExhausted) {
			return lessonTaskRecord{}, err
		}
		return lessonTaskRecord{}, fmt.Errorf("ai: enqueue task: %w", err)
	}
	return result.(lessonTaskRecord), nil
}

// Get returns the record for taskID, or errTaskNotFound.
func (s *LessonTaskStore) Get(ctx context.Context, taskID string) (lessonTaskRecord, error) {
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		rec, ok, readErr := readTaskRecordInTx(tr, taskID)
		if readErr != nil {
			return lessonTaskRecord{}, readErr
		}
		if !ok {
			return lessonTaskRecord{}, errTaskNotFound
		}
		return rec, nil
	})
	if err != nil {
		if errors.Is(err, errTaskNotFound) {
			return lessonTaskRecord{}, err
		}
		return lessonTaskRecord{}, fmt.Errorf("ai: get task: %w", err)
	}
	return result.(lessonTaskRecord), nil
}

// List returns up to limit+offset tasks for a lesson. When activeOnly is true
// only queued/running tasks are returned; the by_lesson/<id>/active index
// already has terminal tasks removed.
func (s *LessonTaskStore) List(
	ctx context.Context,
	lessonID string,
	activeOnly bool,
	limit int,
	offset int,
) ([]lessonTaskRecord, error) {
	bucket := "all"
	if activeOnly {
		bucket = "active"
	}
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		prefix := tuple.Tuple{kvNsLessonTask, "by_lesson", lessonID, bucket}
		rng, err := s.kv.RawPrefix(kvNsLessonTask, prefix)
		if err != nil {
			return nil, err
		}
		rows := tr.GetRange(rng, fdb.RangeOptions{Limit: limit + offset}).Iterator()
		out := make([]lessonTaskRecord, 0, limit)
		skipped := 0
		for rows.Advance() {
			kv := rows.MustGet()
			parts, err := tuple.Unpack(kv.Key)
			if err != nil || len(parts) < 2 {
				continue
			}
			taskID, ok := parts[len(parts)-1].(string)
			if !ok {
				continue
			}
			rec, ok, readErr := readTaskRecordInTx(tr, taskID)
			if readErr != nil {
				return nil, readErr
			}
			if !ok {
				continue
			}
			if skipped < offset {
				skipped++
				continue
			}
			out = append(out, rec)
			if len(out) >= limit {
				break
			}
		}
		return out, nil
	})
	if err != nil {
		return nil, fmt.Errorf("ai: list tasks: %w", err)
	}
	return result.([]lessonTaskRecord), nil
}

// Cancel marks a task CANCELED. The store:
//  1. Writes cancel_signal/<id> so any in-flight worker observes it on its
//     next progress tick.
//  2. Writes r/<id> with status=CANCELED.
//  3. Removes active_target and by_lesson/<id>/active/... and
//     by_user/<user>/active/... indexes so the user can re-enqueue
//     immediately.
//
// Returns the updated record. If the task is already terminal, returns it
// as-is.
func (s *LessonTaskStore) Cancel(ctx context.Context, taskID, message string) (lessonTaskRecord, error) {
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		rec, ok, readErr := readTaskRecordInTx(tr, taskID)
		if readErr != nil {
			return lessonTaskRecord{}, readErr
		}
		if !ok {
			return lessonTaskRecord{}, errTaskNotFound
		}
		if isTerminal(rec.Status) {
			return rec, nil
		}
		now := time.Now().UTC()
		rec.Status = richterv1.LessonTaskStatus_LESSON_TASK_STATUS_CANCELED
		rec.Message = message
		rec.UpdatedAt = now
		rec.FinishedAt = now
		recBytes, marshalErr := marshalLessonTaskRecord(rec)
		if marshalErr != nil {
			return lessonTaskRecord{}, marshalErr
		}
		tr.Set(taskRecordKey(rec.ID), recBytes)
		tr.Set(taskCancelSignalKey(rec.ID), []byte("1"))
		tr.Clear(taskActiveTargetKey(rec.LessonID, rec.Kind, rec.ChunkID))
		tr.Clear(taskByLessonKey(rec.LessonID, "active", rec.CreatedAt, rec.ID))
		tr.Clear(taskByUserKey(rec.CreatedBy, "active", rec.CreatedAt, rec.ID))
		return rec, nil
	})
	if err != nil {
		if errors.Is(err, errTaskNotFound) {
			return lessonTaskRecord{}, err
		}
		return lessonTaskRecord{}, fmt.Errorf("ai: cancel task: %w", err)
	}
	return result.(lessonTaskRecord), nil
}

// ClaimAndPop atomically removes the next queue entry and returns its task ID.
// Returns errQueueEmpty if there is nothing to do.
//
// On success the worker has exclusive ownership of the task; the record's
// status is still QUEUED — the worker flips it to RUNNING via MarkRunning.
func (s *LessonTaskStore) ClaimAndPop(ctx context.Context) (string, error) {
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		prefix := taskQueueKeyPrefix()
		rng, err := s.kv.RawPrefix(kvNsLessonTask, prefix)
		if err != nil {
			return "", err
		}
		rows := tr.GetRange(rng, fdb.RangeOptions{Limit: 1}).Iterator()
		if !rows.Advance() {
			return "", errQueueEmpty
		}
		kv := rows.MustGet()
		taskID := string(kv.Value)
		tr.Clear(kv.Key)
		return taskID, nil
	})
	if err != nil {
		if errors.Is(err, errQueueEmpty) {
			return "", err
		}
		return "", fmt.Errorf("ai: claim task: %w", err)
	}
	return result.(string), nil
}

// MarkRunning transitions a task from QUEUED to RUNNING. Used by the worker
// after ClaimAndPop.
func (s *LessonTaskStore) MarkRunning(ctx context.Context, taskID string) (lessonTaskRecord, error) {
	return s.updateStatus(ctx, taskID,
		richterv1.LessonTaskStatus_LESSON_TASK_STATUS_QUEUED,
		richterv1.LessonTaskStatus_LESSON_TASK_STATUS_RUNNING,
		func(rec *lessonTaskRecord) {
			rec.StartedAt = time.Now().UTC()
		})
}

// UpdateProgress writes a new progress step + counters while the task is
// running. No-op if the task is no longer RUNNING.
func (s *LessonTaskStore) UpdateProgress(
	ctx context.Context,
	taskID, step string,
	current, total int32,
	message string,
) error {
	_, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		rec, ok, readErr := readTaskRecordInTx(tr, taskID)
		if readErr != nil {
			return nil, readErr
		}
		if !ok {
			return nil, errTaskNotFound
		}
		if rec.Status != richterv1.LessonTaskStatus_LESSON_TASK_STATUS_RUNNING {
			return nil, nil
		}
		rec.ProgressStep = step
		rec.ProgressCurrent = current
		rec.ProgressTotal = total
		if message != "" {
			rec.Message = message
		}
		rec.UpdatedAt = time.Now().UTC()
		recBytes, marshalErr := marshalLessonTaskRecord(rec)
		if marshalErr != nil {
			return nil, marshalErr
		}
		tr.Set(taskRecordKey(rec.ID), recBytes)
		return nil, nil
	})
	return err
}

// MarkSucceeded marks a running task as completed successfully.
func (s *LessonTaskStore) MarkSucceeded(ctx context.Context, taskID, message string) (lessonTaskRecord, error) {
	return s.completeTask(ctx, taskID, richterv1.LessonTaskStatus_LESSON_TASK_STATUS_SUCCEEDED, message, "")
}

// MarkFailed marks a running task as failed.
func (s *LessonTaskStore) MarkFailed(ctx context.Context, taskID, message, errMsg string) (lessonTaskRecord, error) {
	return s.completeTask(ctx, taskID, richterv1.LessonTaskStatus_LESSON_TASK_STATUS_FAILED, message, errMsg)
}

// CancelSignalPresent returns true if cancel_signal/<taskID> has been set.
// Workers call this on every progress tick to detect cancellation.
func (s *LessonTaskStore) CancelSignalPresent(ctx context.Context, taskID string) (bool, error) {
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		bytes := tr.Get(taskCancelSignalKey(taskID)).MustGet()
		return bytes != nil, nil
	})
	if err != nil {
		return false, fmt.Errorf("ai: check cancel signal: %w", err)
	}
	return result.(bool), nil
}

// ReclaimStale finds tasks whose StartedAt is older than the timeout and were
// never marked terminal. For each it enqueues a fresh claim by writing the
// record back into the queue. Returns the IDs that were reclaimed.
//
// The reclaim is best-effort: a worker holding a task for too long is presumed
// crashed. We re-push only RUNNING tasks (not QUEUED — those are not yet
// claimed and are fine). When taskCfg.ActiveTimeout is 0 (unlimited), no
// task is ever considered stale and ReclaimStale is a no-op.
func (s *LessonTaskStore) ReclaimStale(ctx context.Context) ([]string, error) {
	activeTimeout := s.taskCfg.ActiveTimeout
	if activeTimeout <= 0 {
		// 0 = unlimited. Skip reclaim entirely.
		return nil, nil
	}
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		prefix := tuple.Tuple{kvNsLessonTask, "r"}
		rng, err := s.kv.RawPrefix(kvNsLessonTask, prefix)
		if err != nil {
			return nil, err
		}
		rows := tr.GetRange(rng, fdb.RangeOptions{Limit: 10_000}).Iterator()
		var reclaimed []string
		cutoff := time.Now().UTC().Add(-activeTimeout)
		for rows.Advance() {
			kv := rows.MustGet()
			rec, ok := fromFdbLessonTaskRecord(kv.Value)
			if !ok {
				continue
			}
			if rec.Status != richterv1.LessonTaskStatus_LESSON_TASK_STATUS_RUNNING {
				continue
			}
			if rec.StartedAt.IsZero() || rec.StartedAt.After(cutoff) {
				continue
			}
			rec.Status = richterv1.LessonTaskStatus_LESSON_TASK_STATUS_QUEUED
			rec.StartedAt = time.Time{}
			rec.UpdatedAt = time.Now().UTC()
			rec.Message = "Đã khôi phục sau khi worker gặp sự cố."
			recBytes, marshalErr := marshalLessonTaskRecord(rec)
			if marshalErr != nil {
				continue
			}
			tr.Set(taskRecordKey(rec.ID), recBytes)
			seq, err := s.lastQueueSeqInTx(tr)
			if err != nil {
				return nil, err
			}
			seq++
			tr.Set(taskQueueKey(seq), []byte(rec.ID))
			reclaimed = append(reclaimed, rec.ID)
		}
		return reclaimed, nil
	})
	if err != nil {
		return nil, fmt.Errorf("ai: reclaim stale tasks: %w", err)
	}
	return result.([]string), nil
}
