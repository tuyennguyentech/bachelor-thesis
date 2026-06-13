package transcript

import (
	"context"
	"fmt"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RunExtract is the worker entry point invoked by the FDB task runner for
// LESSON_TASK_KIND_EXTRACT_TRANSCRIPT. The pipeline:
//
//  1. Per-lesson mutex (rejects double-clicks with a friendly message).
//  2. Mark PG analysis row as PROCESSING (with a stuck-cleanup defer).
//  3. Clear stale FDB transcript + segments for the lesson.
//  4. Hand off to STTRunner (STT via ffmpeg pipeline in the ai package).
//  5. Persist transcript text + segments to FDB.
//  6. Reap old PG chunks + interactions so the next chunk step starts clean.
//  7. Mark PG analysis row as TRANSCRIPT_EXTRACTED.
func (s *Service) RunExtract(
	ctx context.Context,
	lessonID pgtype.UUID,
	videoKey string,
	progress ProgressFn,
) error {
	lessonIDStr := lessonID.String()

	// Per-lesson serialization: a double-click of "Phân tích" would
	// otherwise race STT + ffmpeg + FDB writes. If another request
	// is mid-analysis we return immediately so the existing run owns
	// the pipeline; the client already shows a spinner for the first run.
	lock, ok := s.Locks.TryAcquire(lessonIDStr)
	if !ok {
		return fmt.Errorf("Phân tích đang được xử lý cho bài học này. Vui lòng chờ.")
	}
	defer s.Locks.Release(lessonIDStr, lock)

	// Clear stale FDB data immediately so GetLessonAnalysis won't
	// return transcript/segments from a previously-analyzed video.
	segment.DeleteLessonTranscripts(s.KV, lessonIDStr)

	transcriptText, segs, extractErr := s.Transcription(ctx, videoKey, progress)
	if extractErr != nil {
		return extractErr
	}

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING, "Đang lưu kết quả..."); err != nil {
		s.Log.WarnContext(ctx, "ai: failed to send saving progress after transcript extraction", "err", err)
	}

	// Save transcript + segments to FDB.
	if transcriptText != "" {
		if err := segment.SaveTranscript(s.KV, lessonIDStr, transcriptText); err != nil {
			s.Log.WarnContext(ctx, "ai: FDB transcript write failed", "err", err)
		}
	}
	if len(segs) > 0 {
		if err := segment.SaveSegments(s.KV, lessonIDStr, segs); err != nil {
			s.Log.WarnContext(ctx, "ai: FDB segments write failed", "err", err)
		}
	}

	// Collect chunk IDs for FDB cleanup before the PG delete cascades
	// them away.
	var staleChunkIDs []string
	if existingChunks, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: s.LessonOpsLimit(), Offset: 0})
	}); err == nil {
		for _, c := range existingChunks {
			staleChunkIDs = append(staleChunkIDs, c.ID.String())
		}
	}

	// Clear stale chunks and interactions from any previous run.
	if err := db.WithConnectionExec(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		if err := q.DeleteLessonInteractionsByLesson(ctx, lessonID); err != nil {
			s.Log.WarnContext(ctx, "ai: failed to delete stale interactions on re-extract", "err", err)
		}
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		s.Log.WarnContext(ctx, "ai: failed to clear stale chunks on re-extract", "err", err)
	}

	// Best-effort FDB cleanup for the chunks we just deleted from PG.
	for _, id := range staleChunkIDs {
		_ = segment.DeleteChunkTranscript(s.KV, id)
	}

	return nil
}
