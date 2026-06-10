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
// chunkingService.runGeminiChunk here. Returns a slice of proposed chunks;
// persistence happens in RunChunk below.
type ChunkRunner func(ctx context.Context, transcript string, segmentsJSON []byte) ([]ChunkProposal, error)

// RunChunk is the worker entry point for LESSON_TASK_KIND_CHUNK_TRANSCRIPT.
// It validates the prerequisite transcript exists, asks Gemini for chunk
// boundaries, persists the chunks (and their per-segment coherence), then
// rewrites the chunk-level FDB transcripts in a single shot.
func (s *Service) RunChunk(
	ctx context.Context,
	lessonID pgtype.UUID,
	progress ProgressFn,
) error {
	if err := db.WithConnectionExec(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID, Status: gen.LessonAnalysisStatusProcessing, ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return err
	}

	// If we exit without setting a final status (SIGTERM/panic during
	// the Gemini call), reset to ERROR so the user can retry.
	chunkStatusFinalized := false
	defer func() {
		if chunkStatusFinalized {
			return
		}
		bgCtx, bgCancel := s.AiCtx(context.Background(), s.AiCfg.BackgroundTaskTimeout)
		defer bgCancel()
		if _, err := db.WithConnection(s.Postgres, bgCtx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
			return q.UpsertLessonAnalysisStatus(bgCtx, gen.UpsertLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: "Quá trình bị gián đoạn. Vui lòng thử lại.", Valid: true},
			})
		}); err != nil {
			s.Log.ErrorContext(bgCtx, "ai: chunk cleanup defer: failed to reset stuck PROCESSING status", "err", err)
		}
	}()

	lessonIDStr := lessonID.String()
	transcriptText := segment.LoadTranscript(s.KV, lessonIDStr)
	if transcriptText == "" {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript found — run Step 2 (extract transcript) first"))
	}

	segmentsBytes := segment.LoadSegmentsPromptJSON(s.KV, lessonIDStr)
	allSegs := segment.LoadSegments(s.KV, lessonIDStr)

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, "Đang phân tích nội dung để xác định đoạn..."); err != nil {
		return err
	}

	chunks, chunkErr := s.Chunk(ctx, transcriptText, segmentsBytes)
	if chunkErr == nil && len(chunks) == 0 {
		chunkErr = fmt.Errorf("Gemini returned 0 chunks — transcript may be too short or model response was empty")
	}
	if chunkErr != nil {
		_ = db.WithConnectionExec(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: chunkErr.Error(), Valid: true},
			})
		})
		chunkStatusFinalized = true
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
			chunkSegs := segment.ChunkSegments(allSegs, ch.StartSeconds, ch.EndSeconds)
			coherence := segment.ComputeChunkCoherence(chunkSegs)
			dbChunk, err := q.InsertLessonTranscriptChunk(ctx, gen.InsertLessonTranscriptChunkParams{
				LessonID:            lessonID,
				OrderIndex:          int32(i),
				StartSeconds:        float64(ch.StartSeconds),
				EndSeconds:          float64(ch.EndSeconds),
				Summary:             ch.Summary,
				QuestionCountConfig: 1,
				CoherenceScore:      coherence,
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
		_ = db.WithConnectionExec(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: "Lỗi khi lưu đoạn nội dung: " + saveErr.Error(), Valid: true},
			})
		})
		chunkStatusFinalized = true
		return fmt.Errorf("Lỗi khi lưu đoạn nội dung: %w", saveErr)
	}

	if err := db.WithConnectionExec(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   gen.LessonAnalysisStatusChunksReady,
			ErrorMsg: pgtype.Text{},
		})
	}); err != nil {
		s.Log.ErrorContext(ctx, "ai: failed to update status to chunks_ready", svc.LogAttrs("UpdateLessonAnalysisStatus", err)...)
	}
	chunkStatusFinalized = true

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
