package generation

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai/genengine"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProgressFunc func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error

type FetchChunkTranscriptFunc func(chunkID string) string

type EmbedAudioFunc func(
	ctx context.Context,
	ttsProv svcinteractions.TTSProvider,
	configJSON []byte,
	text string,
	lessonLanguage string,
	lessonID string,
) ([]byte, error)

type Deps struct {
	Postgres             *db.PostgresSvc
	Log                  *log.LogSvc
	AiCfg                *cfg.AiCfg
	Engine               genengine.Engine
	FetchChunkTranscript FetchChunkTranscriptFunc
	EmbedAudio           EmbedAudioFunc
	ChunksLimit          func() int32
	InteractionsLimit    func() int32
}

type Service struct {
	pg                   *db.PostgresSvc
	log                  *log.LogSvc
	aiCfg                *cfg.AiCfg
	engine               genengine.Engine
	fetchChunkTranscript FetchChunkTranscriptFunc
	embedAudio           EmbedAudioFunc
	chunksLimit          func() int32
	interactionsLimit    func() int32
}

func New(deps Deps) *Service {
	return &Service{
		pg:                   deps.Postgres,
		log:                  deps.Log,
		aiCfg:                deps.AiCfg,
		engine:               deps.Engine,
		fetchChunkTranscript: deps.FetchChunkTranscript,
		embedAudio:           deps.EmbedAudio,
		chunksLimit:          deps.ChunksLimit,
		interactionsLimit:    deps.InteractionsLimit,
	}
}

func (s *Service) Run(
	ctx context.Context,
	lessonID pgtype.UUID,
	req *richterv1.GenerateInteractionsRequest,
	send ProgressFunc,
) error {
	chunks, err := s.loadTargetChunks(ctx, lessonID, req.GetChunkId())
	if err != nil {
		return err
	}
	if len(chunks) == 0 {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("no transcript chunks found — run Step 4 (chunk transcript) first"))
	}

	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return svc.ConnectDBError(err)
	}

	total := int32(len(chunks))
	// Whole-lesson generate (chunkId == "") only FILLS empty chunks — chunks that
	// already have questions are skipped so a re-run/pipeline-resume never touches
	// them (this is what prevents duplicate accumulation on resume). A single-chunk
	// generate is an explicit user action and is never skipped here: it APPENDS to
	// that chunk (see saveInteractionsForChunk) unless force-regenerate replaces.
	chunkHasInteractions := map[string]bool{}
	if !req.GetForceRegenerate() && req.GetChunkId() == "" {
		existingInts, intErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
			return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: lessonID, Limit: s.interactionsLimit(), Offset: 0})
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

	reqKinds := req.GetInteractionKinds()
	if len(reqKinds) == 0 {
		if lk := req.GetInteractionKind(); lk != richterv1.InteractionKind_INTERACTION_KIND_UNSPECIFIED { //nolint:staticcheck // deprecated field
			reqKinds = []richterv1.InteractionKind{lk}
		}
	}

	// Item generation goes through the injected engine (s.engine) — real Gemini
	// or the mock, selected by config. No client is created here.
	savedThisRun := 0
	failedChunks := 0
	var lastGenErr error
	for i, chunk := range chunks {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		if !req.GetForceRegenerate() && req.GetChunkId() == "" && chunkHasInteractions[chunk.ID.String()] {
			_ = send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_CHUNK, fmt.Sprintf("Đoạn %d/%d đã có bài tập, bỏ qua", i+1, total), int32(i), total)
			continue
		}

		chunkTranscript := s.fetchChunkTranscript(chunk.ID.String())
		if strings.TrimSpace(chunkTranscript) == "" {
			s.log.WarnContext(ctx, "ai: chunk has no transcript, skipping", "chunk_id", chunk.ID.String())
			if sendErr := send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR, fmt.Sprintf("Đoạn %d/%d không có nội dung transcript, bỏ qua", i+1, total), int32(i), total); sendErr != nil {
				return nil
			}
			continue
		}

		plan := resolveGenerationPlan(chunk, lesson, reqKinds, req.GetCountPerChunk(), req.GetStrategy())
		allItems, genErr := s.generateForChunk(ctx, chunk, chunkTranscript, lesson.Language, req.GetDifficulty(), req.GetFocusPrompt(), plan)
		if genErr != nil {
			// A canceled task context (user pressed Hủy, worker shutdown, client
			// disconnected) is a graceful ABORT, not a model failure — return like the
			// top-of-loop ctx.Done() check so it isn't reported as a quota/API error.
			if ctx.Err() != nil {
				return nil
			}
			// The model call FAILED for this chunk (quota/429/malformed/network) — this
			// is NOT the same as "produced 0 items". Record it so a run where every
			// chunk fails is reported as a failure rather than a silent success. The
			// existing questions for this chunk are left untouched (no save → no delete).
			failedChunks++
			lastGenErr = genErr
			if sendErr := send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR, fmt.Sprintf("Đoạn %d/%d: gọi AI thất bại (%s) — giữ nguyên bài tập cũ, tiếp tục", i+1, total, friendlyGeminiError(genErr).Error()), int32(i), total); sendErr != nil {
				return nil
			}
			continue
		}
		if len(allItems) == 0 {
			continue
		}
		if saved, saveErr := s.saveInteractionsForChunk(ctx, lessonID, chunk.ID, allItems, req.GetForceRegenerate()); saveErr != nil {
			// Canceled task context (Hủy / shutdown / disconnect) → graceful abort, not
			// a save failure.
			if ctx.Err() != nil {
				return nil
			}
			s.log.ErrorContext(ctx, "ai: failed to save interactions for chunk",
				"chunk_id", chunk.ID.String(), "err", saveErr)
			if sendErr := send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR, fmt.Sprintf("Lỗi lưu bài tập đoạn %d/%d: %s — bỏ qua, tiếp tục", i+1, total, saveErr.Error()), int32(i), total); sendErr != nil {
				return nil
			}
		} else {
			savedThisRun += len(saved)
			if sendErr := send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_CHUNK, fmt.Sprintf("Hoàn thành đoạn %d/%d: %s (%d bài tập)", i+1, total, chunk.Summary, len(saved)), int32(i), total); sendErr != nil {
				return nil
			}
		}
	}

	if savedThisRun == 0 {
		// A real AI failure must NEVER be reported as success. If at least one chunk
		// FAILED the model call and nothing was saved this run, fail the task with the
		// real reason — even when the lesson already has old interactions (the previous
		// behaviour silently returned DONE here, so a total Gemini/quota outage looked
		// like "nothing happened but succeeded"). This is the fix for the "chạy AI
		// không tạo được gì mà vẫn báo xong" regression.
		if failedChunks > 0 {
			return connect.NewError(connect.CodeUnavailable, fmt.Errorf(
				"sinh bài tập thất bại: %d/%d đoạn lỗi khi gọi AI (%s) — thường do hết hạn mức (quota) hoặc khóa API Gemini; kiểm tra rồi thử lại",
				failedChunks, total, friendlyGeminiError(lastGenErr).Error()))
		}
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
			_ = send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_ERROR, msg, 0, total)
			return nil
		}
	}

	return send(richterv1.GenerateInteractionsStep_GENERATE_INTERACTIONS_STEP_DONE, "", 0, total)
}

func (s *Service) loadTargetChunks(ctx context.Context, lessonID pgtype.UUID, chunkIDStr string) ([]gen.LessonTranscriptChunk, error) {
	if chunkIDStr != "" {
		chunkID, err := svc.ParseUUID(chunkIDStr)
		if err != nil {
			return nil, err
		}
		c, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
			return q.GetLessonTranscriptChunk(ctx, chunkID)
		})
		if err != nil {
			return nil, svc.ConnectDBError(err)
		}
		if c.LessonID != lessonID {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunk does not belong to the requested lesson"))
		}
		return []gen.LessonTranscriptChunk{c}, nil
	}
	listed, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: s.chunksLimit(), Offset: 0})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return listed, nil
}

// generateForChunk returns the generated items for one chunk. The error is non-nil
// ONLY when the model call itself failed and produced nothing (e.g. Gemini quota /
// 429 / malformed JSON) — an empty slice with a nil error means the model legitimately
// returned no usable items. Run relies on this distinction so a real AI failure is
// surfaced to the user instead of being masked as "0 exercises, success".
func (s *Service) generateForChunk(
	ctx context.Context,
	chunk gen.LessonTranscriptChunk,
	chunkTranscript string,
	lessonLanguage string,
	difficulty string,
	focusPrompt string,
	plan generationPlan,
) ([]generatedItem, error) {
	var allItems []generatedItem
	if plan.useAIChoose {
		items, genErr := s.GenerateItemsAIChoose(ctx, chunk, chunkTranscript, plan.aiKinds, plan.aiCount, lessonLanguage, difficulty, focusPrompt)
		if genErr != nil {
			s.log.WarnContext(ctx, "ai: AI_CHOOSE generation failed", "chunk_id", chunk.ID.String(), "err", genErr)
			return nil, genErr
		}
		return items, nil
	}
	var lastErr error
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
			items, genErr := s.GenerateItems(ctx, chunkCopy, chunkTranscript, geminiGen, kindStr, lessonLanguage, difficulty, focusPrompt)
			if genErr != nil {
				s.log.WarnContext(ctx, "ai: failed to generate items for kind, continuing", "kind", kc.kind, "count", batchCount, "err", genErr)
				lastErr = genErr
			} else {
				allItems = append(allItems, items...)
			}
			remaining -= batchCount
		}
	}
	// A partial success (some kinds produced items) is still useful — keep it. Only
	// report failure when EVERY batch failed and nothing at all was produced.
	if len(allItems) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return allItems, nil
}
