package transcript

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ChunkProposal mirrors the JSON shape Gemini returns for one chunk.
// Persistence happens in RunChunk below.
type ChunkProposal struct {
	StartSeconds float32
	EndSeconds   float32
	Summary      string
}

// ChunkRunner is the Gemini chunking pipeline. The ai package wires
// chunkingService.runGeminiChunk here. `language` is the lesson's output
// language, used so the chunk summaries follow it. Returns a slice of proposed
// chunks; persistence happens in RunChunk below.
type ChunkRunner func(ctx context.Context, transcript string, segmentsJSON []byte, language string) ([]ChunkProposal, error)

// RunChunk is the worker entry point for LESSON_TASK_KIND_CHUNK_TRANSCRIPT.
// It validates the prerequisite transcript exists, asks Gemini for chunk
// boundaries, persists the chunks, then
// rewrites the chunk-level FDB transcripts in a single shot.
func (s *Service) RunChunk(
	ctx context.Context,
	lessonID pgtype.UUID,
	progress ProgressFn,
) error {
	lessonIDStr := lessonID.String()
	transcriptText := segment.LoadTranscript(s.KV, lessonIDStr)
	if transcriptText == "" {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript found — run Step 2 (extract transcript) first"))
	}
	// Refuse to chunk a degenerate repetition-loop transcript — otherwise Gemini
	// confabulates plausible-looking summaries over garbage. Guards a transcript
	// stored before the VAD fix; a fresh re-extract will produce a clean one.
	if IsDegenerateTranscript(transcriptText) {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("phiên âm bị lặp bất thường — vui lòng chạy lại bước phiên âm (Trích xuất transcript) trước khi phân đoạn"))
	}

	segmentsBytes := segment.LoadSegmentsPromptJSON(s.KV, lessonIDStr)
	allSegs := segment.LoadSegments(s.KV, lessonIDStr)

	// Lesson output language drives the chunk-summary language. Best-effort: a
	// load failure just falls back to the empty string (→ Vietnamese default),
	// it must not block chunking.
	var language string
	if lesson, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	}); err == nil {
		language = lesson.Language
	}

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, "Đang phân tích nội dung để xác định đoạn..."); err != nil {
		return err
	}

	chunks, chunkErr := s.Chunk(ctx, transcriptText, segmentsBytes, language)
	if chunkErr == nil && len(chunks) == 0 {
		chunkErr = fmt.Errorf("Gemini returned 0 chunks — transcript may be too short or model response was empty")
	}
	if chunkErr != nil {
		return chunkErr
	}

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING, "Đang lưu các đoạn..."); err != nil {
		return err
	}

	type chunkFDBEntry struct {
		id, transcript string
	}
	var chunkFDBEntries []chunkFDBEntry
	var staleChunkIDs []string

	saveErr := db.WithCommitTxExec(s.Postgres, ctx, func(q *gen.Queries, _ pgx.Tx) error {
		existing, err := q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: s.ChunksLimit(), Offset: 0})
		if err != nil {
			return fmt.Errorf("list existing chunks: %w", err)
		}
		for _, ec := range existing {
			staleChunkIDs = append(staleChunkIDs, ec.ID.String())
			if err := q.DeleteLessonInteractionsByChunk(ctx, ec.ID); err != nil {
				return fmt.Errorf("delete interactions for chunk %s: %w", ec.ID, err)
			}
		}
		if err := q.DeleteLessonTranscriptChunks(ctx, lessonID); err != nil {
			return fmt.Errorf("delete old chunks: %w", err)
		}

		for i, ch := range chunks {
			dbChunk, err := q.InsertLessonTranscriptChunk(ctx, gen.InsertLessonTranscriptChunkParams{
				LessonID:            lessonID,
				OrderIndex:          int32(i),
				StartSeconds:        float64(ch.StartSeconds),
				EndSeconds:          float64(ch.EndSeconds),
				Summary:             ch.Summary,
				QuestionCountConfig: 1,
			})
			if err != nil {
				return fmt.Errorf("insert chunk %d: %w", i, err)
			}
			chunkText := segment.BuildChunkTranscript(allSegs, ch.StartSeconds, ch.EndSeconds)
			if chunkText == "" {
				chunkText = transcriptText
			}
			chunkFDBEntries = append(chunkFDBEntries, chunkFDBEntry{
				id:         dbChunk.ID.String(),
				transcript: chunkText,
			})
		}
		return nil
	})
	if saveErr != nil {
		s.Log.ErrorContext(ctx, "ai: failed to save chunks", svc.LogAttrs("ChunkTranscriptStream", saveErr)...)
		return fmt.Errorf("Lỗi khi lưu đoạn nội dung: %w", saveErr)
	}

	// Clear FDB transcripts for the OLD chunks we just deleted.
	for _, id := range staleChunkIDs {
		_ = segment.DeleteChunkTranscript(s.KV, id)
	}

	for _, e := range chunkFDBEntries {
		if e.transcript == "" {
			continue
		}
		if err := segment.SaveChunkTranscript(s.KV, e.id, e.transcript); err != nil {
			s.Log.WarnContext(ctx, "ai: FDB chunk transcript write failed", "chunk_id", e.id, "err", err)
		}
	}

	return nil
}
