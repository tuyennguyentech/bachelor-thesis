package transcript

import (
	"context"
	"fmt"
	"strings"

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
//  3. Clear ALL stale derived state up front: FDB transcript + segments AND the PG
//     chunks + interactions from any previous run — so a transcribe that fails below
//     cannot leave orphaned downstream artifacts (an inconsistent "transcribe failed
//     but chunks present" state on reload).
//  4. Hand off to STTRunner (STT via ffmpeg pipeline in the ai package).
//  5. Persist transcript text + segments to FDB.
//  6. Mark PG analysis row as TRANSCRIPT_EXTRACTED.
func (s *Service) RunExtract(
	ctx context.Context,
	lessonID pgtype.UUID,
	videoKey string,
	audioLang string,
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

	// Clear ALL stale derived state UP FRONT — the FDB transcript + segments AND the
	// PG chunks + interactions from any previous run. A (re-)transcribe rebuilds the
	// transcript from scratch, so everything downstream is stale REGARDLESS of whether
	// this run succeeds. Doing the cleanup here — not only on the success path below —
	// means a FAILED / degenerate transcribe leaves a consistent "transcribe failed,
	// nothing downstream" state, instead of orphaned chunks that make the stepper show
	// "Phân đoạn: N đoạn" (green) under a red "Phiên âm thất bại" on reload (bug #15).
	// It's a no-op on a first-time transcribe (nothing to delete).
	segment.DeleteLessonTranscripts(s.KV, lessonIDStr)

	// Snapshot chunk ids for FDB cleanup before the PG delete removes the rows.
	var staleChunkIDs []string
	if existingChunks, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: s.LessonOpsLimit(), Offset: 0})
	}); err == nil {
		for _, c := range existingChunks {
			staleChunkIDs = append(staleChunkIDs, c.ID.String())
		}
	}
	if err := db.WithConnectionExec(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		if err := q.DeleteLessonInteractionsByLesson(ctx, lessonID); err != nil {
			s.Log.WarnContext(ctx, "ai: failed to delete stale interactions on re-extract", "err", err)
		}
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		s.Log.WarnContext(ctx, "ai: failed to clear stale chunks on re-extract", "err", err)
	}
	for _, id := range staleChunkIDs {
		_ = segment.DeleteChunkTranscript(s.KV, id)
	}

	transcriptText, segs, extractErr := s.Transcription(ctx, videoKey, audioLang, progress)
	if extractErr != nil {
		return extractErr
	}

	// Guard against a degenerate repetition-loop transcript (faster-whisper
	// stuck on non-speech, emitting one short phrase ×N). Fail loudly BEFORE
	// persisting so the garbage never reaches FDB or the chunk/generate steps
	// (where Gemini would confabulate plausible-looking summaries over it).
	if IsDegenerateTranscript(transcriptText) {
		return fmt.Errorf("phiên âm bị lặp bất thường — âm thanh có thể quá ngắn, nhiều nhạc/nhiễu, hoặc không rõ tiếng nói. Vui lòng thử lại hoặc dùng video có lời nói rõ hơn.")
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

	return nil
}

// degenerateMinTokens is the floor below which a transcript is too short to
// judge for repetition — genuine short clips shouldn't be flagged.
const degenerateMinTokens = 30

// IsDegenerateTranscript reports whether a transcript looks like a Whisper
// repetition-loop hallucination (one short phrase emitted over and over, e.g.
// "Kết hợp phép tính" ×hundreds) rather than real speech. It flags text whose
// distinct-token ratio is very low, or where a single token dominates — both
// signatures of a decode loop. Short transcripts are never flagged. This is a
// cheap, language-agnostic guard (whitespace tokenization) run before the
// transcript is persisted/chunked.
func IsDegenerateTranscript(text string) bool {
	fields := strings.Fields(text)
	n := len(fields)
	if n < degenerateMinTokens {
		return false
	}
	counts := make(map[string]int, n)
	maxCount := 0
	for _, f := range fields {
		k := strings.ToLower(f)
		counts[k]++
		if counts[k] > maxCount {
			maxCount = counts[k]
		}
	}
	distinctRatio := float64(len(counts)) / float64(n)
	// A loop of a k-word phrase repeated m times has distinctRatio ≈ k/(k*m) = 1/m,
	// which collapses toward 0 as it loops; real speech stays well above 0.15.
	if distinctRatio < 0.15 {
		return true
	}
	// Or a single token swamps the transcript (degenerate single-word loop).
	if float64(maxCount)/float64(n) > 0.5 {
		return true
	}
	return false
}
