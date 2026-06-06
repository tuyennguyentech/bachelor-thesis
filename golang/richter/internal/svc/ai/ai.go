package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ── Step 2: ExtractTranscriptStream ──────────────────────────────────────────

// progressFn is called at each analysis step; returning a non-nil error aborts the pipeline.
type progressFn func(step richterv1.AnalysisProgressStep, msg string) error

func (s *AISvc) ExtractTranscriptStream(
	ctx context.Context,
	req *richterv1.ExtractTranscriptRequest,
	stream *connect.ServerStream[richterv1.AnalysisProgressEvent],
) error {
	lessonID, videoKey, err := s.authorizeAndLoadLesson(ctx, req.GetLessonId())
	if err != nil {
		return err
	}
	if err := s.runExtractTranscript(ctx, lessonID, videoKey, func(step richterv1.AnalysisProgressStep, msg string) error {
		return stream.Send(&richterv1.AnalysisProgressEvent{Step: step, Message: msg})
	}); err != nil {
		_ = stream.Send(&richterv1.AnalysisProgressEvent{
			Step:    richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ERROR,
			Message: err.Error(),
		})
		return nil
	}
	return stream.Send(&richterv1.AnalysisProgressEvent{
		Step: richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DONE,
	})
}

func (s *AISvc) runExtractTranscript(
	ctx context.Context,
	lessonID pgtype.UUID,
	videoKey string,
	progress progressFn,
) error {
	// Per-lesson serialization: a double-click of "Phân tích" would otherwise
	// race Whisper + ffmpeg + FDB writes, corrupting the chunk set. If another
	// request is mid-analysis we return immediately so the existing run owns
	// the pipeline; the client already shows a spinner for the first run.
	lessonKey := lessonID.String()
	lock, ok := analysisLocks.tryAcquire(lessonKey)
	if !ok {
		return fmt.Errorf("Phân tích đang được xử lý cho bài học này. Vui lòng chờ.")
	}
	defer analysisLocks.release(lessonKey, lock)

	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID, Status: gen.LessonAnalysisStatusProcessing, ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return err
	}

	// If the server is killed (SIGTERM) or panics while PROCESSING, reset status to ERROR
	// so the user can retry instead of being stuck with a spinning "Đang xử lý…".
	statusFinalized := false
	defer func() {
		if statusFinalized {
			return
		}
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.WithConnection(s.pg, bgCtx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
			return q.UpsertLessonAnalysisStatus(bgCtx, gen.UpsertLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: "Quá trình bị gián đoạn. Vui lòng thử lại.", Valid: true},
			})
		}); err != nil {
			s.log.ErrorContext(bgCtx, "ai: cleanup defer: failed to reset stuck PROCESSING status", "err", err)
		}
	}()

	lessonIDStr := lessonID.String()
	// Clear stale FDB data immediately after PROCESSING is set so GetLessonAnalysis
	// won't return transcript/segments from a previously-analyzed video.
	_ = s.kv.Delete(kvNsLesson, tuple.Tuple{lessonIDStr, "transcript"})
	_ = s.kv.Delete(kvNsLesson, tuple.Tuple{lessonIDStr, "segments"})

	transcript, segments, extractErr := s.transcription.runWhisperAnalyze(ctx, videoKey, progress)
	if extractErr != nil {
		statusFinalized = s.persistExtractError(ctx, lessonID, extractErr.Error())
		return extractErr
	}

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING, "Đang lưu kết quả..."); err != nil {
		s.log.WarnContext(ctx, "ai: failed to send saving progress after transcript extraction", "err", err)
	}

	// Save transcript + segments to FDB.
	segmentsJSON, err := json.Marshal(segments)
	if err != nil {
		s.log.ErrorContext(ctx, "ai: failed to marshal segments", svc.LogAttrs("json.Marshal", err)...)
		segmentsJSON = []byte("[]")
	}
	if transcript != "" {
		if err := s.kv.Set(kvNsLesson, tuple.Tuple{lessonIDStr, "transcript"}, []byte(transcript)); err != nil {
			s.log.WarnContext(ctx, "ai: FDB transcript write failed", "err", err)
		}
	}
	if len(segmentsJSON) > 0 {
		if err := s.kv.Set(kvNsLesson, tuple.Tuple{lessonIDStr, "segments"}, segmentsJSON); err != nil {
			s.log.WarnContext(ctx, "ai: FDB segments write failed", "err", err)
		}
	}

	// Collect chunk IDs for FDB cleanup before the PG delete cascades them away.
	var staleChunkIDs []string
	if existingChunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 10000, Offset: 0})
	}); err == nil {
		for _, c := range existingChunks {
			staleChunkIDs = append(staleChunkIDs, c.ID.String())
		}
	}

	// Clear stale chunks and interactions from any previous run.
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		if err := q.DeleteLessonInteractionsByLesson(ctx, lessonID); err != nil {
			s.log.WarnContext(ctx, "ai: failed to delete stale interactions on re-extract", "err", err)
		}
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		s.log.WarnContext(ctx, "ai: failed to clear stale chunks on re-extract", "err", err)
	}

	// Best-effort FDB cleanup for the chunks we just deleted from PG.
	for _, id := range staleChunkIDs {
		_ = s.kv.Delete(kvNsChunk, tuple.Tuple{id, "transcript"})
	}
	finalStatus := gen.LessonAnalysisStatusTranscriptExtracted

	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   finalStatus,
			ErrorMsg: pgtype.Text{},
		})
	}); err != nil {
		s.log.ErrorContext(ctx, "ai: failed to update analysis status", svc.LogAttrs("UpdateLessonAnalysisStatus", err)...)
	}
	statusFinalized = true

	return nil
}

// ── Step 3: UpdateTranscriptSegment ──────────────────────────────────────────

func (s *AISvc) UpdateTranscriptSegment(
	ctx context.Context,
	req *richterv1.UpdateTranscriptSegmentRequest,
) (*richterv1.UpdateTranscriptSegmentResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}

	segmentsBytes, err := s.kv.Get(kvNsLesson, tuple.Tuple{lessonID.String(), "segments"})
	if err != nil || len(segmentsBytes) == 0 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no segments found — run Step 2 first"))
	}

	var segments []transcriptSegment
	if err := json.Unmarshal(segmentsBytes, &segments); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("parse segments: %w", err))
	}

	idx := int(req.GetSegmentIndex())
	if idx < 0 || idx >= len(segments) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("segment_index %d out of range [0, %d)", idx, len(segments)))
	}

	segments[idx].Text = req.GetText()

	updated, err := json.Marshal(segments)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("marshal segments: %w", err))
	}
	if err := s.kv.Set(kvNsLesson, tuple.Tuple{lessonID.String(), "segments"}, updated); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("save segments: %w", err))
	}

	// Rebuild transcript text so ChunkTranscriptStream sees the edited content.
	var parts []string
	for _, seg := range segments {
		if seg.Text != "" {
			parts = append(parts, seg.Text)
		}
	}
	rebuiltTranscript := strings.Join(parts, " ")
	if err := s.kv.Set(kvNsLesson, tuple.Tuple{lessonID.String(), "transcript"}, []byte(rebuiltTranscript)); err != nil {
		s.log.WarnContext(ctx, "ai: failed to rebuild transcript after segment edit", "err", err)
	}

	// If chunks already exist, rebuild each chunk's FDB transcript AND its
	// coherence score from the (now-edited) segments. Without this, the chunk
	// transcripts shipped to Gemini for question regeneration would contain the
	// OLD segment text and the coverage score would still reflect the old
	// vocabulary.
	if chunks, cerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 10000, Offset: 0})
	}); cerr == nil {
		for _, c := range chunks {
			segsInChunk := chunkSegments(segments, float32(c.StartSeconds), float32(c.EndSeconds))
			chunkText := buildChunkTranscript(segments, float32(c.StartSeconds), float32(c.EndSeconds))
			if chunkText != "" {
				if err := s.kv.Set(kvNsChunk, tuple.Tuple{c.ID.String(), "transcript"}, []byte(chunkText)); err != nil {
					s.log.WarnContext(ctx, "ai: failed to rebuild chunk transcript after segment edit",
						"chunk_id", c.ID.String(), "err", err)
				}
			}
			newCoherence := computeChunkCoherence(segsInChunk)
			if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
				return q.UpdateChunkCoherence(ctx, gen.UpdateChunkCoherenceParams{ID: c.ID, CoherenceScore: newCoherence})
			}); err != nil {
				s.log.WarnContext(ctx, "ai: failed to update chunk coherence after segment edit",
					"chunk_id", c.ID.String(), "err", err)
			}
		}
	}

	seg := segments[idx]
	return &richterv1.UpdateTranscriptSegmentResponse{
		Segment: &richterv1.TranscriptSegment{
			StartSeconds: seg.StartSeconds,
			EndSeconds:   seg.EndSeconds,
			Text:         seg.Text,
		},
	}, nil
}

// ── Step 4: ChunkTranscriptStream ─────────────────────────────────────────────

func (s *AISvc) ChunkTranscriptStream(
	ctx context.Context,
	req *richterv1.ChunkTranscriptRequest,
	stream *connect.ServerStream[richterv1.AnalysisProgressEvent],
) error {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return err
	}

	if err := s.runChunkTranscript(ctx, lessonID, func(step richterv1.AnalysisProgressStep, msg string) error {
		return stream.Send(&richterv1.AnalysisProgressEvent{Step: step, Message: msg})
	}); err != nil {
		return err
	}
	return stream.Send(&richterv1.AnalysisProgressEvent{
		Step: richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DONE,
	})
}

func (s *AISvc) runChunkTranscript(
	ctx context.Context,
	lessonID pgtype.UUID,
	progress progressFn,
) error {
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID, Status: gen.LessonAnalysisStatusProcessing, ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return err
	}

	// Cleanup: if we exit without setting a final status (SIGTERM/panic during Gemini call),
	// reset to ERROR so the user can retry instead of being stuck with "Đang xử lý…".
	chunkStatusFinalized := false
	defer func() {
		if chunkStatusFinalized {
			return
		}
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.WithConnection(s.pg, bgCtx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
			return q.UpsertLessonAnalysisStatus(bgCtx, gen.UpsertLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: "Quá trình bị gián đoạn. Vui lòng thử lại.", Valid: true},
			})
		}); err != nil {
			s.log.ErrorContext(bgCtx, "ai: chunk cleanup defer: failed to reset stuck PROCESSING status", "err", err)
		}
	}()

	transcriptBytes, err := s.kv.Get(kvNsLesson, tuple.Tuple{lessonID.String(), "transcript"})
	if err != nil || len(transcriptBytes) == 0 {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript found — run Step 2 (extract transcript) first"))
	}

	segmentsBytes, _ := s.kv.Get(kvNsLesson, tuple.Tuple{lessonID.String(), "segments"})
	var allSegs []transcriptSegment
	if len(segmentsBytes) > 0 {
		_ = json.Unmarshal(segmentsBytes, &allSegs)
	}

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, "Đang phân tích nội dung để xác định đoạn..."); err != nil {
		return err
	}

	chunks, chunkErr := s.chunking.runGeminiChunk(ctx, string(transcriptBytes), segmentsBytes)
	if chunkErr == nil && len(chunks) == 0 {
		chunkErr = fmt.Errorf("Gemini returned 0 chunks — transcript may be too short or model response was empty")
	}
	if chunkErr != nil {
		_ = db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
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

	type chunkFDBEntry struct{ id, transcript string }
	var chunkFDBEntries []chunkFDBEntry
	var staleChunkIDs []string

	saveErr := db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) error {
		// Delete old interactions and chunks atomically.
		existing, err := q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 500, Offset: 0})
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
			chunkSegs := chunkSegments(allSegs, ch.StartSeconds, ch.EndSeconds)
			coherence := computeChunkCoherence(chunkSegs)
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
			chunkText := buildChunkTranscript(allSegs, ch.StartSeconds, ch.EndSeconds)
			if chunkText == "" {
				chunkText = string(transcriptBytes)
			}
			chunkFDBEntries = append(chunkFDBEntries, chunkFDBEntry{
				id:         dbChunk.ID.String(),
				transcript: chunkText,
			})
		}
		return nil
	})
	if saveErr != nil {
		s.log.ErrorContext(ctx, "ai: failed to save chunks", svc.LogAttrs("ChunkTranscriptStream", saveErr)...)
		// Persist the specific error message so the defer's generic "interrupted"
		// fallback doesn't overwrite it after we return.
		_ = db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: "Lỗi khi lưu đoạn nội dung: " + saveErr.Error(), Valid: true},
			})
		})
		chunkStatusFinalized = true
		return fmt.Errorf("Lỗi khi lưu đoạn nội dung: %w", saveErr)
	}

	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   gen.LessonAnalysisStatusChunksReady,
			ErrorMsg: pgtype.Text{},
		})
	}); err != nil {
		s.log.ErrorContext(ctx, "ai: failed to update status to chunks_ready", svc.LogAttrs("UpdateLessonAnalysisStatus", err)...)
	}
	chunkStatusFinalized = true

	// Clear FDB transcripts for the OLD chunks that were just deleted in the tx
	// above. Their PG rows are gone but their FDB content was previously written
	// under their (now-orphaned) chunk_ids, which never collide with the fresh
	// chunk ids we generate below.
	for _, id := range staleChunkIDs {
		_ = s.kv.Delete(kvNsChunk, tuple.Tuple{id, "transcript"})
	}

	for _, e := range chunkFDBEntries {
		if e.transcript == "" {
			continue
		}
		if err := s.kv.Set(kvNsChunk, tuple.Tuple{e.id, "transcript"}, []byte(e.transcript)); err != nil {
			s.log.WarnContext(ctx, "ai: FDB chunk transcript write failed", "chunk_id", e.id, "err", err)
		}
	}

	return nil
}

// ── Step 5: Chunk editing ─────────────────────────────────────────────────────

func (s *AISvc) ListLessonTranscriptChunks(
	ctx context.Context,
	req *richterv1.ListLessonTranscriptChunksRequest,
) (*richterv1.ListLessonTranscriptChunksResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	chunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		limit := req.GetLimit()
		if limit == 0 {
			limit = 500
		}
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: limit, Offset: req.GetOffset()})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	protoChunks := make([]*richterv1.TranscriptChunk, 0, len(chunks))
	for _, c := range chunks {
		protoChunks = append(protoChunks, chunkToProto(c))
	}
	return &richterv1.ListLessonTranscriptChunksResponse{Chunks: protoChunks}, nil
}

func (s *AISvc) UpdateChunkConfig(
	ctx context.Context,
	req *richterv1.UpdateChunkConfigRequest,
) (*richterv1.UpdateChunkConfigResponse, error) {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return nil, err
	}

	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, chunk.LessonID); err != nil {
		return nil, err
	}

	updated, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.UpdateChunkQuestionCountConfig(ctx, gen.UpdateChunkQuestionCountConfigParams{
			ID:                  chunkID,
			QuestionCountConfig: req.GetQuestionCount(),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateChunkConfigResponse{Chunk: chunkToProto(updated)}, nil
}

func (s *AISvc) MergeChunks(
	ctx context.Context,
	req *richterv1.MergeChunksRequest,
) (*richterv1.MergeChunksResponse, error) {
	keepID, err := svc.ParseUUID(req.GetKeepChunkId())
	if err != nil {
		return nil, err
	}
	discardID, err := svc.ParseUUID(req.GetDiscardChunkId())
	if err != nil {
		return nil, err
	}
	if keepID == discardID {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("keep and discard must be different chunks"))
	}

	keepChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, keepID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, keepChunk.LessonID); err != nil {
		return nil, err
	}

	discardChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, discardID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if keepChunk.LessonID != discardChunk.LessonID {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunks must belong to the same lesson"))
	}

	diff := keepChunk.OrderIndex - discardChunk.OrderIndex
	if diff != 1 && diff != -1 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("only adjacent chunks can be merged"))
	}

	keepTranscript := s.fetchChunkTranscript(keepID.String())
	discardTranscript := s.fetchChunkTranscript(discardID.String())

	mergedStart := min(keepChunk.StartSeconds, discardChunk.StartSeconds)
	mergedEnd := max(keepChunk.EndSeconds, discardChunk.EndSeconds)

	var mergedTranscript string
	if keepChunk.OrderIndex < discardChunk.OrderIndex {
		mergedTranscript = keepTranscript + "\n" + discardTranscript
	} else {
		mergedTranscript = discardTranscript + "\n" + keepTranscript
	}

	// Write merged transcript to FDB before PG commit: keepID is known, so if PG fails the
	// FDB entry is harmless (same key, next successful merge will overwrite).
	if err := s.kv.Set(kvNsChunk, tuple.Tuple{keepID.String(), "transcript"}, []byte(mergedTranscript)); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("write merged transcript to FDB: %w", err))
	}

	allSegs := s.loadSegmentsFromFDB(keepChunk.LessonID.String())
	mergedCoherence := computeChunkCoherence(chunkSegments(allSegs, float32(mergedStart), float32(mergedEnd)))

	var mergedChunk gen.LessonTranscriptChunk
	if err := db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) error {
		if err := q.DeleteLessonInteractionsByChunk(ctx, discardID); err != nil {
			return fmt.Errorf("delete discard questions: %w", err)
		}
		if err := q.DeleteLessonTranscriptChunk(ctx, discardID); err != nil {
			return fmt.Errorf("delete discard chunk: %w", err)
		}
		updated, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID:             keepID,
			StartSeconds:   mergedStart,
			EndSeconds:     mergedEnd,
			Summary:        keepChunk.Summary,
			CoherenceScore: mergedCoherence,
		})
		if err != nil {
			return fmt.Errorf("update keep chunk boundaries: %w", err)
		}
		mergedChunk = updated
		return q.ReorderLessonChunks(ctx, keepChunk.LessonID)
	}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("merge chunks: %w", err))
	}

	_ = s.kv.Delete(kvNsChunk, tuple.Tuple{discardID.String(), "transcript"})

	return &richterv1.MergeChunksResponse{MergedChunk: chunkToProto(mergedChunk)}, nil
}

func (s *AISvc) DeleteChunk(
	ctx context.Context,
	req *richterv1.DeleteChunkRequest,
) (*richterv1.DeleteChunkResponse, error) {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return nil, err
	}

	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, chunk.LessonID); err != nil {
		return nil, err
	}

	if err := db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) error {
		if err := q.DeleteLessonInteractionsByChunk(ctx, chunkID); err != nil {
			return fmt.Errorf("delete questions: %w", err)
		}
		if err := q.DeleteLessonTranscriptChunk(ctx, chunkID); err != nil {
			return fmt.Errorf("delete chunk: %w", err)
		}
		return q.ReorderLessonChunks(ctx, chunk.LessonID)
	}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("delete chunk: %w", err))
	}

	_ = s.kv.Delete(kvNsChunk, tuple.Tuple{chunkID.String(), "transcript"})

	return &richterv1.DeleteChunkResponse{}, nil
}

func (s *AISvc) SplitChunk(
	ctx context.Context,
	req *richterv1.SplitChunkRequest,
) (*richterv1.SplitChunkResponse, error) {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return nil, err
	}
	splitAt := float32(req.GetSplitAtSeconds())

	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("chunk not found"))
		}
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, chunk.LessonID); err != nil {
		return nil, err
	}
	if splitAt <= float32(chunk.StartSeconds) || splitAt >= float32(chunk.EndSeconds) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("split_at_seconds %.1f must be within (%.1f, %.1f)", splitAt, chunk.StartSeconds, chunk.EndSeconds))
	}

	allSegs := s.loadSegmentsFromFDB(chunk.LessonID.String())
	firstTranscript := buildChunkTranscript(allSegs, float32(chunk.StartSeconds), splitAt)
	secondTranscript := buildChunkTranscript(allSegs, splitAt, float32(chunk.EndSeconds))
	firstCoherence := computeChunkCoherence(chunkSegments(allSegs, float32(chunk.StartSeconds), splitAt))
	secondCoherence := computeChunkCoherence(chunkSegments(allSegs, splitAt, float32(chunk.EndSeconds)))

	type splitResult struct {
		first       gen.LessonTranscriptChunk
		second      gen.LessonTranscriptChunk
		secondNewID pgtype.UUID
	}
	result, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (splitResult, error) {
		updated, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID: chunk.ID, StartSeconds: chunk.StartSeconds,
			EndSeconds: float64(splitAt), Summary: chunk.Summary,
			CoherenceScore: firstCoherence,
		})
		if err != nil {
			return splitResult{}, svc.ConnectDBError(err)
		}

		existingChunks, err := q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: chunk.LessonID, Limit: 500, Offset: 0})
		if err != nil {
			return splitResult{}, svc.ConnectDBError(err)
		}
		maxOrder := int32(0)
		for _, c := range existingChunks {
			if c.OrderIndex > maxOrder {
				maxOrder = c.OrderIndex
			}
		}
		newChunk, err := q.InsertLessonTranscriptChunk(ctx, gen.InsertLessonTranscriptChunkParams{
			LessonID: chunk.LessonID, OrderIndex: maxOrder + 1,
			StartSeconds: float64(splitAt), EndSeconds: chunk.EndSeconds,
			Summary: chunk.Summary, QuestionCountConfig: chunk.QuestionCountConfig,
			CoherenceScore: secondCoherence,
		})
		if err != nil {
			return splitResult{}, svc.ConnectDBError(err)
		}

		if err := q.ReorderLessonChunks(ctx, chunk.LessonID); err != nil {
			return splitResult{}, fmt.Errorf("reorder chunks after split: %w", err)
		}

		first, err := q.GetLessonTranscriptChunk(ctx, updated.ID)
		if err != nil {
			return splitResult{}, fmt.Errorf("re-fetch first chunk after split: %w", err)
		}
		second, err := q.GetLessonTranscriptChunk(ctx, newChunk.ID)
		if err != nil {
			return splitResult{}, fmt.Errorf("re-fetch second chunk after split: %w", err)
		}
		return splitResult{first: first, second: second, secondNewID: newChunk.ID}, nil
	})
	if err != nil {
		return nil, err
	}

	// FDB writes happen after PG commit so stale FDB data is never left behind on PG rollback.
	// On failure, log a warning — FDB can be corrected on next read or re-run; PG is authoritative.
	if firstTranscript != "" {
		if err := s.kv.Set(kvNsChunk, tuple.Tuple{chunk.ID.String(), "transcript"}, []byte(firstTranscript)); err != nil {
			s.log.WarnContext(ctx, "ai: SplitChunk first chunk FDB write failed",
				"chunk_id", chunk.ID.String(), "err", err)
		}
	}
	if secondTranscript != "" {
		if err := s.kv.Set(kvNsChunk, tuple.Tuple{result.secondNewID.String(), "transcript"}, []byte(secondTranscript)); err != nil {
			s.log.WarnContext(ctx, "ai: SplitChunk second chunk FDB write failed — transcript lost",
				"chunk_id", result.secondNewID.String(), "err", err)
		}
	}

	return &richterv1.SplitChunkResponse{
		FirstChunk:  chunkToProto(result.first),
		SecondChunk: chunkToProto(result.second),
	}, nil
}

// ── Step 5d: AdjustChunkBoundary ─────────────────────────────────────────────

func (s *AISvc) AdjustChunkBoundary(
	ctx context.Context,
	req *richterv1.AdjustChunkBoundaryRequest,
) (*richterv1.AdjustChunkBoundaryResponse, error) {
	prevID, err := svc.ParseUUID(req.GetPrevChunkId())
	if err != nil {
		return nil, err
	}
	nextID, err := svc.ParseUUID(req.GetNextChunkId())
	if err != nil {
		return nil, err
	}
	newBoundary := float32(req.GetNewBoundarySeconds())

	prevChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, prevID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("prev chunk not found"))
		}
		return nil, svc.ConnectDBError(err)
	}
	nextChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, nextID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("next chunk not found"))
		}
		return nil, svc.ConnectDBError(err)
	}
	if prevChunk.LessonID != nextChunk.LessonID {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunks belong to different lessons"))
	}
	if prevChunk.OrderIndex+1 != nextChunk.OrderIndex {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunks are not adjacent (order_index %d and %d)", prevChunk.OrderIndex, nextChunk.OrderIndex))
	}
	if err := s.requireTeacherRole(ctx, prevChunk.LessonID); err != nil {
		return nil, err
	}
	if newBoundary <= float32(prevChunk.StartSeconds) || newBoundary >= float32(nextChunk.EndSeconds) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("new_boundary_seconds %.1f must be within (%.1f, %.1f)",
				newBoundary, prevChunk.StartSeconds, nextChunk.EndSeconds))
	}

	allSegs := s.loadSegmentsFromFDB(prevChunk.LessonID.String())
	prevTranscript := buildChunkTranscript(allSegs, float32(prevChunk.StartSeconds), newBoundary)
	nextTranscript := buildChunkTranscript(allSegs, newBoundary, float32(nextChunk.EndSeconds))
	prevCoherence := computeChunkCoherence(chunkSegments(allSegs, float32(prevChunk.StartSeconds), newBoundary))
	nextCoherence := computeChunkCoherence(chunkSegments(allSegs, newBoundary, float32(nextChunk.EndSeconds)))

	type boundaryResult struct {
		prev gen.LessonTranscriptChunk
		next gen.LessonTranscriptChunk
	}
	result, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (boundaryResult, error) {
		// Re-fetch inside the transaction to guard against concurrent reorders.
		currentPrev, err := q.GetLessonTranscriptChunk(ctx, prevID)
		if err != nil {
			return boundaryResult{}, svc.ConnectDBError(err)
		}
		currentNext, err := q.GetLessonTranscriptChunk(ctx, nextID)
		if err != nil {
			return boundaryResult{}, svc.ConnectDBError(err)
		}
		if currentPrev.OrderIndex+1 != currentNext.OrderIndex {
			return boundaryResult{}, connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("chunks are no longer adjacent — another edit may have changed their order"))
		}
		updPrev, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID: prevID, StartSeconds: currentPrev.StartSeconds, EndSeconds: float64(newBoundary), Summary: currentPrev.Summary,
			CoherenceScore: prevCoherence,
		})
		if err != nil {
			return boundaryResult{}, svc.ConnectDBError(err)
		}
		updNext, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID: nextID, StartSeconds: float64(newBoundary), EndSeconds: currentNext.EndSeconds, Summary: currentNext.Summary,
			CoherenceScore: nextCoherence,
		})
		if err != nil {
			return boundaryResult{}, svc.ConnectDBError(err)
		}
		return boundaryResult{prev: updPrev, next: updNext}, nil
	})
	if err != nil {
		return nil, err
	}

	// FDB writes happen after PG commit so stale FDB data is never left behind on PG rollback.
	// On failure, log a warning — FDB can be corrected on next read or re-run; PG is authoritative.
	if prevTranscript != "" {
		if err := s.kv.Set(kvNsChunk, tuple.Tuple{prevID.String(), "transcript"}, []byte(prevTranscript)); err != nil {
			s.log.WarnContext(ctx, "ai: AdjustChunkBoundary prev chunk FDB write failed",
				"chunk_id", prevID.String(), "err", err)
		}
	}
	if nextTranscript != "" {
		if err := s.kv.Set(kvNsChunk, tuple.Tuple{nextID.String(), "transcript"}, []byte(nextTranscript)); err != nil {
			s.log.WarnContext(ctx, "ai: AdjustChunkBoundary next chunk FDB write failed",
				"chunk_id", nextID.String(), "err", err)
		}
	}

	return &richterv1.AdjustChunkBoundaryResponse{
		PrevChunk: chunkToProto(result.prev),
		NextChunk: chunkToProto(result.next),
	}, nil
}

// ── Generation config helpers ─────────────────────────────────────────────────

const defaultGenerationCount = 2

// kindCount pairs a kind with how many interactions to generate for it in a single chunk.
type kindCount struct {
	kind  richterv1.InteractionKind
	count int32
}

// generationPlan describes how to generate interactions for one chunk.
// Exactly one of useAIChoose or len(evenCounts)>0 is set.
type generationPlan struct {
	useAIChoose bool
	aiKinds     []richterv1.InteractionKind // AI_CHOOSE: allowed kinds
	aiCount     int32                       // AI_CHOOSE: total items to request
	evenCounts  []kindCount                 // EVEN_DISTRIBUTION: per-kind counts
}

func interactionGenerationBatchSize(kind richterv1.InteractionKind) int32 {
	// Listening and reading items each carry a long passage + several nested
	// MCQ; a batch of 2 reading items can push Gemini past its 16K-token
	// limit even at 65536 max output. Single-item batches are safe.
	switch kind {
	case richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
		richterv1.InteractionKind_INTERACTION_KIND_READING:
		return 1
	default:
		return 4
	}
}

// resolveGenerationPlan merges chunk config → lesson default → server default → request overrides
// and returns the effective generation plan.
func resolveGenerationPlan(
	chunk gen.LessonTranscriptChunk,
	lesson gen.Lesson,
	reqKinds []richterv1.InteractionKind,
	reqCount int32,
	reqStrategy richterv1.GenerationStrategy,
) generationPlan {
	var cfgKinds []richterv1.InteractionKind
	cfgCount := int32(chunk.QuestionCountConfig)
	cfgStrategy := richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED

	if d := interactionConfigFromJSON(lesson.DefaultInteractionConfig); d != nil {
		if len(d.Kinds) > 0 {
			cfgKinds = d.Kinds
		}
		if d.Count > 0 {
			cfgCount = d.Count
		}
		if d.Strategy != richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED {
			cfgStrategy = d.Strategy
		}
	}
	if c := interactionConfigFromJSON(chunk.InteractionConfig); c != nil {
		if len(c.Kinds) > 0 {
			cfgKinds = c.Kinds
		}
		if c.Count > 0 {
			cfgCount = c.Count
		}
		if c.Strategy != richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED {
			cfgStrategy = c.Strategy
		}
	}

	// Request-level overrides take highest priority.
	if len(reqKinds) > 0 {
		cfgKinds = reqKinds
	}
	if reqCount > 0 {
		cfgCount = reqCount
	}
	if reqStrategy != richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED {
		cfgStrategy = reqStrategy
	}

	// Server defaults.
	if len(cfgKinds) == 0 {
		cfgKinds = []richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE}
	}
	if cfgCount <= 0 {
		cfgCount = defaultGenerationCount
	}

	// UNSPECIFIED → AI_CHOOSE (default).
	if cfgStrategy != richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION {
		return generationPlan{useAIChoose: true, aiKinds: cfgKinds, aiCount: cfgCount}
	}

	// EVEN_DISTRIBUTION: round-robin across cfgKinds.
	kindMap := make(map[richterv1.InteractionKind]int32, len(cfgKinds))
	for i := int32(0); i < cfgCount; i++ {
		k := cfgKinds[i%int32(len(cfgKinds))]
		kindMap[k]++
	}
	seen := make(map[richterv1.InteractionKind]bool)
	result := make([]kindCount, 0, len(kindMap))
	for _, k := range cfgKinds {
		if !seen[k] {
			seen[k] = true
			result = append(result, kindCount{k, kindMap[k]})
		}
	}
	return generationPlan{evenCounts: result}
}

func friendlyLanguageName(langCode string) string {
	switch strings.ToLower(langCode) {
	case "vi":
		return "Tiếng Việt (Vietnamese)"
	case "en":
		return "Tiếng Anh (English)"
	default:
		if langCode != "" {
			return langCode
		}
		return "Tiếng Việt (Vietnamese)"
	}
}

func strongLanguageInstruction(langCode string) string {
	langName := friendlyLanguageName(langCode)
	if strings.ToLower(langCode) == "en" {
		return fmt.Sprintf("BẮT BUỘC SỬ DỤNG TIẾNG ANH (ngôn ngữ: %s) cho toàn bộ câu hỏi, câu trả lời, phương án lựa chọn, đáp án đúng, giải thích đáp án. KHÔNG ĐƯỢC viết bằng tiếng Việt hay bất kỳ ngôn ngữ nào khác.", langName)
	}
	return fmt.Sprintf("BẮT BUỘC SỬ DỤNG TIẾNG VIỆT (ngôn ngữ: %s) cho toàn bộ câu hỏi, câu trả lời, phương án lựa chọn, đáp án đúng, giải thích đáp án. KHÔNG ĐƯỢC viết bằng tiếng Anh hay bất kỳ ngôn ngữ nào khác (trừ phi đó là bài tập đặc thù về dịch thuật hoặc học từ vựng tiếng Anh).", langName)
}

// buildAIChoosePrompt constructs the Gemini prompt for AI_CHOOSE mode.
// Each allowed kind contributes its prompt hint and schema; the model picks per item.
func buildAIChoosePrompt(
	chunk gen.LessonTranscriptChunk,
	transcript string,
	totalCount int32,
	specs []aiChooseKindSpec,
	difficulty string,
	focusPrompt string,
	lessonLanguage string,
) string {
	var kindDescs strings.Builder
	kindNames := make([]string, 0, len(specs))
	for _, sp := range specs {
		fmt.Fprintf(&kindDescs, "- \"%s\": %s\n  Schema cho loại này:\n%s\n\n",
			sp.kindStr, sp.generator.GeminiPromptHint(), sp.generator.GeminiSchema())
		kindNames = append(kindNames, `"`+sp.kindStr+`"`)
	}
	allowedList := strings.Join(kindNames, ", ")

	var customInstructions strings.Builder
	if difficulty != "" {
		fmt.Fprintf(&customInstructions, "Mức độ khó của câu hỏi PHẢI là: %s.\n", difficulty)
	}
	if focusPrompt != "" {
		fmt.Fprintf(&customInstructions, "Tập trung vào yêu cầu/chủ đề sau khi tạo câu hỏi: %s.\n", focusPrompt)
	}
	fmt.Fprintf(&customInstructions, "%s\n", strongLanguageInstruction(lessonLanguage))

	return fmt.Sprintf(
		`Bạn là trợ lý giáo dục. Dựa trên đoạn nội dung bài giảng sau, hãy tạo %d bài tập để kiểm tra hiểu biết của học sinh.

%sVới mỗi bài tập, chọn loại phù hợp nhất từ các loại cho phép:
%s
Đoạn nội dung (%.1f - %.1f giây):
%s

start_seconds PHẢI bằng thời điểm kết thúc đoạn: %.1f giây.

Mỗi item trong mảng "items" PHẢI có trường "kind" (một trong: %s) và các trường tương ứng với loại đó theo schema ở trên.

Trả về JSON object: {"items": [...]}`,
		totalCount,
		customInstructions.String(),
		kindDescs.String(),
		float32(chunk.StartSeconds), float32(chunk.EndSeconds),
		transcript,
		float32(chunk.EndSeconds),
		allowedList,
	)
}

// aiChooseKindSpec is used internally by buildAIChoosePrompt and runGeminiGenerateItemsAIChoose.
type aiChooseKindSpec struct {
	kindStr   string
	generator svcinteractions.GeminiGenerator
}

// ── Step 7: GenerateInteractionsStream ───────────────────────────────────────

type generateProgressFn func(event *richterv1.GenerateInteractionsProgressEvent) error

func (s *AISvc) GenerateInteractionsStream(
	ctx context.Context,
	req *richterv1.GenerateInteractionsRequest,
	stream *connect.ServerStream[richterv1.GenerateInteractionsProgressEvent],
) error {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return err
	}

	return s.runGenerateInteractions(ctx, lessonID, req, func(event *richterv1.GenerateInteractionsProgressEvent) error {
		return stream.Send(event)
	})
}

func (s *AISvc) runGenerateInteractions(
	ctx context.Context,
	lessonID pgtype.UUID,
	req *richterv1.GenerateInteractionsRequest,
	send generateProgressFn,
) error {
	var chunks []gen.LessonTranscriptChunk

	if req.GetChunkId() != "" {
		chunkID, err := svc.ParseUUID(req.GetChunkId())
		if err != nil {
			return err
		}
		c, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
			return q.GetLessonTranscriptChunk(ctx, chunkID)
		})
		if err != nil {
			return svc.ConnectDBError(err)
		}
		// Defense in depth: ensure the chunk belongs to the requested lesson.
		if c.LessonID != lessonID {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunk does not belong to the requested lesson"))
		}
		chunks = []gen.LessonTranscriptChunk{c}
	} else {
		listed, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
			return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 500, Offset: 0})
		})
		if err != nil {
			return svc.ConnectDBError(err)
		}
		chunks = listed
	}

	if len(chunks) == 0 {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript chunks found — run Step 4 (chunk transcript) first"))
	}

	// Load lesson for default_interaction_config fallback.
	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return svc.ConnectDBError(err)
	}

	total := int32(len(chunks))

	// Pre-load which chunks already have interactions (skip-if-exists optimisation).
	chunkHasInteractions := map[string]bool{}
	if !req.GetForceRegenerate() && req.GetChunkId() == "" {
		existingInts, intErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
			return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: lessonID, Limit: 5000, Offset: 0})
		})
		if intErr != nil {
			s.log.WarnContext(ctx, "ai: could not load existing interactions for skip check; will attempt all chunks", "err", intErr)
		}
		for _, ei := range existingInts {
			if ei.ChunkID.Valid {
				chunkHasInteractions[ei.ChunkID.String()] = true
			}
		}
	}

	// Resolve request-level overrides (applied on top of per-chunk config in the loop).
	reqKinds := req.GetInteractionKinds()
	// Honour legacy interaction_kind field if interaction_kinds is empty.
	if len(reqKinds) == 0 {
		if lk := req.GetInteractionKind(); lk != richterv1.InteractionKind_INTERACTION_KIND_UNSPECIFIED { //nolint:staticcheck // deprecated field
			reqKinds = []richterv1.InteractionKind{lk}
		}
	}
	reqCount := req.GetCountPerChunk()
	reqStrategy := req.GetStrategy()

	// Determine if any chunk actually needs Gemini.
	needsGemini := req.GetForceRegenerate() || req.GetChunkId() != ""
	if !needsGemini {
		for _, chunk := range chunks {
			if !chunkHasInteractions[chunk.ID.String()] {
				needsGemini = true
				break
			}
		}
	}

	var geminiClient *genai.Client
	if needsGemini {
		geminiClient, err = newGeminiClient(ctx, s.geminiCfg)
		if err != nil {
			_ = send(&richterv1.GenerateInteractionsProgressEvent{
				Step:    richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR,
				Message: err.Error(),
			})
			return nil
		}
		defer geminiClient.Close()
	}

	savedThisRun := 0

	// Sequential processing — simpler, easier to debug, and one bad chunk doesn't stall others.
	for i, chunk := range chunks {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		if !req.GetForceRegenerate() && req.GetChunkId() == "" && chunkHasInteractions[chunk.ID.String()] {
			_ = send(&richterv1.GenerateInteractionsProgressEvent{
				Step:        richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_CHUNK,
				Message:     fmt.Sprintf("Đoạn %d/%d đã có bài tập, bỏ qua", i+1, total),
				ChunkIndex:  int32(i),
				TotalChunks: total,
			})
			continue
		}

		chunkTranscript := s.fetchChunkTranscript(chunk.ID.String())
		if strings.TrimSpace(chunkTranscript) == "" {
			s.log.WarnContext(ctx, "ai: chunk has no transcript, skipping", "chunk_id", chunk.ID.String())
			if sendErr := send(&richterv1.GenerateInteractionsProgressEvent{
				Step:        richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR,
				Message:     fmt.Sprintf("Đoạn %d/%d không có nội dung transcript, bỏ qua", i+1, total),
				ChunkIndex:  int32(i),
				TotalChunks: total,
			}); sendErr != nil {
				return nil
			}
			continue
		}

		// Resolve effective generation plan for this chunk.
		plan := resolveGenerationPlan(chunk, lesson, reqKinds, reqCount, reqStrategy)

		var allItems []generatedItem
		if plan.useAIChoose {
			items, genErr := s.interactionGen.runGeminiGenerateItemsAIChoose(ctx, geminiClient, chunk, chunkTranscript, plan.aiKinds, plan.aiCount, lesson.Language, req.GetDifficulty(), req.GetFocusPrompt())
			if genErr != nil {
				s.log.WarnContext(ctx, "ai: AI_CHOOSE generation failed", "chunk_id", chunk.ID.String(), "err", genErr)
			} else {
				allItems = items
			}
		} else {
			for _, kc := range plan.evenCounts {
				handler := svcinteractions.Get(kc.kind)
				if handler == nil {
					s.log.WarnContext(ctx, "ai: no handler for kind, skipping", "kind", kc.kind)
					continue
				}
				geminiGen, ok := handler.(svcinteractions.GeminiGenerator)
				if !ok {
					s.log.WarnContext(ctx, "ai: kind has no Gemini generator, skipping", "kind", kc.kind)
					continue
				}
				kindStr := svcinteractions.KindToDBString(kc.kind)
				batchSize := interactionGenerationBatchSize(kc.kind)
				for remaining := kc.count; remaining > 0; {
					batchCount := remaining
					if batchCount > batchSize {
						batchCount = batchSize
					}
					chunkCopy := chunk
					chunkCopy.QuestionCountConfig = batchCount
					items, genErr := s.interactionGen.runGeminiGenerateItems(ctx, geminiClient, chunkCopy, chunkTranscript, geminiGen, kindStr, lesson.Language, req.GetDifficulty(), req.GetFocusPrompt())
					if genErr != nil {
						s.log.WarnContext(ctx, "ai: failed to generate items for kind, continuing", "kind", kc.kind, "count", batchCount, "err", genErr)
					} else {
						allItems = append(allItems, items...)
					}
					remaining -= batchCount
				}
			}
		}

		if len(allItems) == 0 {
			continue
		}
		if saved, saveErr := s.saveInteractionsForChunk(ctx, lessonID, chunk.ID, allItems); saveErr != nil {
			s.log.ErrorContext(ctx, "ai: failed to save interactions for chunk",
				"chunk_id", chunk.ID.String(), "err", saveErr)
			if sendErr := send(&richterv1.GenerateInteractionsProgressEvent{
				Step:        richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR,
				Message:     fmt.Sprintf("Lỗi lưu bài tập đoạn %d/%d: %s — bỏ qua, tiếp tục", i+1, total, saveErr.Error()),
				ChunkIndex:  int32(i),
				TotalChunks: total,
			}); sendErr != nil {
				return nil
			}
		} else {
			savedThisRun += len(saved)
			if sendErr := send(&richterv1.GenerateInteractionsProgressEvent{
				Step:        richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_CHUNK,
				Message:     fmt.Sprintf("Hoàn thành đoạn %d/%d: %s (%d bài tập)", i+1, total, chunk.Summary, len(saved)),
				ChunkIndex:  int32(i),
				TotalChunks: total,
			}); sendErr != nil {
				return nil
			}
		}
	}

	if savedThisRun == 0 {
		hasExistingInteractions := false
		if req.GetChunkId() == "" {
			existing, listErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
				return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: lessonID, Limit: 1, Offset: 0})
			})
			if listErr != nil {
				s.log.WarnContext(ctx, "ai: failed to verify generated interactions", "err", listErr)
			}
			hasExistingInteractions = len(existing) > 0
		}
		if !hasExistingInteractions {
			msg := "Không tạo được bài tập nào từ các phân đoạn hiện tại. Hãy kiểm tra transcript, cấu hình loại câu hỏi hoặc thử lại."
			if req.GetChunkId() == "" {
				_ = db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
					return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
						LessonID: lessonID,
						Status:   gen.LessonAnalysisStatusError,
						ErrorMsg: pgtype.Text{String: msg, Valid: true},
					})
				})
			}
			_ = send(&richterv1.GenerateInteractionsProgressEvent{
				Step:        richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR,
				Message:     msg,
				TotalChunks: total,
			})
			return nil
		}
	}

	if req.GetChunkId() == "" {
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			return q.UpdateLessonAnalysisStatus(ctx, gen.UpdateLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusDone,
				ErrorMsg: pgtype.Text{},
			})
		}); err != nil {
			s.log.ErrorContext(ctx, "ai: failed to mark analysis done", svc.LogAttrs("UpdateLessonAnalysisStatus", err)...)
		}
	}

	return send(&richterv1.GenerateInteractionsProgressEvent{
		Step:        richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_DONE,
		TotalChunks: total,
	})
}

// ── Gemini helpers ────────────────────────────────────────────────────────────

// extractStatusCode extracts an HTTP status code string from a Gemini error message.
// Returns "429", "503", etc. if found, otherwise "rate limit".
func extractStatusCode(msg string) string {
	for _, code := range []string{"503", "429", "500", "502", "504"} {
		if strings.Contains(msg, code) {
			return code
		}
	}
	return "rate limit"
}

// friendlyGeminiError maps verbose Gemini API errors to user-readable messages.
func friendlyGeminiError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	// Check for rate-limit / quota signals. "rate" alone is too broad (matches "generate").
	isRateLimit := strings.Contains(msg, "429") ||
		strings.Contains(msg, "quota") ||
		strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "ratelimit") ||
		strings.Contains(msg, "RATE_LIMIT_EXCEEDED") ||
		strings.Contains(msg, "RESOURCE_EXHAUSTED") ||
		strings.Contains(msg, "503") ||
		strings.Contains(msg, "overloaded")
	if isRateLimit {
		return fmt.Errorf("Vượt hạn mức Gemini API (%s). Vui lòng thử lại sau vài phút.", extractStatusCode(msg))
	}
	return err
}

func geminiResponseText(resp *genai.GenerateContentResponse) (string, error) {
	if len(resp.Candidates) == 0 {
		return "", fmt.Errorf("empty gemini response: no candidates")
	}
	cand := resp.Candidates[0]
	// MAX_TOKENS finish reason means the JSON was cut off mid-generation.
	if cand.FinishReason != 0 && cand.FinishReason != genai.FinishReasonStop {
		return "", fmt.Errorf("gemini stopped unexpectedly (finish_reason=%v) — try a shorter input or increase max_output_tokens", cand.FinishReason)
	}
	if cand.Content == nil || len(cand.Content.Parts) == 0 {
		return "", fmt.Errorf("empty gemini response: no content parts")
	}
	var b strings.Builder
	for _, p := range cand.Content.Parts {
		if txt, ok := p.(genai.Text); ok {
			b.WriteString(string(txt))
		}
	}
	raw := strings.TrimSpace(b.String())
	if raw == "" {
		return "", fmt.Errorf("empty gemini response: no text content")
	}
	// Strip markdown code fences that some models add even with ResponseMIMEType=application/json.
	if strings.HasPrefix(raw, "```") {
		// Remove opening fence: ```json or ```
		if after, found := strings.CutPrefix(raw, "```json"); found {
			raw = after
		} else {
			raw, _ = strings.CutPrefix(raw, "```")
		}
		// Remove closing fence: prefer \n``` (fence on its own line) to avoid
		// accidentally truncating JSON content that happens to contain backticks.
		if idx := strings.LastIndex(raw, "\n```"); idx != -1 {
			raw = raw[:idx]
		} else if idx := strings.LastIndex(raw, "```"); idx != -1 {
			raw = raw[:idx]
		}
		raw = strings.TrimSpace(raw)
	}
	return raw, nil
}

// generatedItem is the common output of any Gemini generation run.
type generatedItem struct {
	prompt      string
	explanation string
	startSecs   float32
	configJSON  []byte
	kindStr     string
}

func normalizeGeneratedInteractionStartSeconds(ints []gen.LessonInteraction, chunks []gen.LessonTranscriptChunk) {
	if len(ints) == 0 || len(chunks) == 0 {
		return
	}
	chunkEndByID := make(map[string]float32, len(chunks))
	for _, chunk := range chunks {
		if chunk.EndSeconds > 0 {
			chunkEndByID[chunk.ID.String()] = float32(chunk.EndSeconds)
		}
	}
	for i := range ints {
		if ints[i].GeneratedBy != "ai" || ints[i].StartSeconds > 0 || !ints[i].ChunkID.Valid {
			continue
		}
		if endSeconds, ok := chunkEndByID[ints[i].ChunkID.String()]; ok {
			ints[i].StartSeconds = endSeconds
		}
	}
}

func generatedInteractionCheckpointSeconds(chunk gen.LessonTranscriptChunk) float32 {
	if chunk.EndSeconds > 0 {
		return float32(chunk.EndSeconds)
	}
	if chunk.StartSeconds > 0 {
		return float32(chunk.StartSeconds)
	}
	return 0
}

func (s *AISvc) insertInteractionsInTx(ctx context.Context, q *gen.Queries, lessonID, chunkID pgtype.UUID, items []generatedItem) ([]gen.LessonInteraction, error) {
	saved := make([]gen.LessonInteraction, 0, len(items))
	nextIdx, err := q.GetLessonInteractionNextOrderIndex(ctx, lessonID)
	if err != nil {
		return saved, fmt.Errorf("compute order_index: %w", err)
	}
	for i, item := range items {
		li, err := q.InsertLessonInteraction(ctx, gen.InsertLessonInteractionParams{
			LessonID:     lessonID,
			ChunkID:      chunkID,
			Kind:         item.kindStr,
			StartSeconds: item.startSecs,
			OrderIndex:   nextIdx + int32(i),
			Prompt:       item.prompt,
			Explanation:  item.explanation,
			Config:       item.configJSON,
			MaxScore:     1.0,
			GeneratedBy:  "ai",
		})
		if err != nil {
			return saved, err
		}
		saved = append(saved, li)
	}
	return saved, nil
}

func (s *AISvc) saveInteractionsForChunk(ctx context.Context, lessonID pgtype.UUID, chunkID pgtype.UUID, items []generatedItem) ([]gen.LessonInteraction, error) {
	return db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) ([]gen.LessonInteraction, error) {
		return s.insertInteractionsInTx(ctx, q, lessonID, chunkID, items)
	})
}
