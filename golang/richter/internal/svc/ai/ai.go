package ai

import (
	"context"
	"fmt"
	"strings"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ── Step 3: UpdateTranscriptSegment ──────────────────────────────────────────

func (s *AISvc) UpdateTranscriptSegment(
	ctx context.Context,
	req *richterv1.UpdateTranscriptSegmentRequest,
) (*richterv1.UpdateTranscriptSegmentResponse, error) {
	return s.transcript.UpdateSegment(ctx, req)
}

// ── Step 5: Chunk editing ─────────────────────────────────────────────────────

func (s *AISvc) ListLessonTranscriptChunks(
	ctx context.Context,
	req *richterv1.ListLessonTranscriptChunksRequest,
) (*richterv1.ListLessonTranscriptChunksResponse, error) {
	return s.transcript.List(ctx, req)
}

func (s *AISvc) UpdateChunkConfig(
	ctx context.Context,
	req *richterv1.UpdateChunkConfigRequest,
) (*richterv1.UpdateChunkConfigResponse, error) {
	return s.transcript.UpdateConfig(ctx, req)
}

func (s *AISvc) MergeChunks(
	ctx context.Context,
	req *richterv1.MergeChunksRequest,
) (*richterv1.MergeChunksResponse, error) {
	mergedChunk, err := s.chunkOps.Merge(ctx, req)
	if err != nil {
		return nil, err
	}
	return &richterv1.MergeChunksResponse{MergedChunk: chunkToProto(mergedChunk)}, nil
}

func (s *AISvc) DeleteChunk(
	ctx context.Context,
	req *richterv1.DeleteChunkRequest,
) (*richterv1.DeleteChunkResponse, error) {
	if err := s.chunkOps.Delete(ctx, req); err != nil {
		return nil, err
	}
	return &richterv1.DeleteChunkResponse{}, nil
}

func (s *AISvc) SplitChunk(
	ctx context.Context,
	req *richterv1.SplitChunkRequest,
) (*richterv1.SplitChunkResponse, error) {
	result, err := s.chunkOps.Split(ctx, req)
	if err != nil {
		return nil, err
	}
	return &richterv1.SplitChunkResponse{
		FirstChunk:  chunkToProto(result.First),
		SecondChunk: chunkToProto(result.Second),
	}, nil
}

// ── Step 5d: AdjustChunkBoundary ─────────────────────────────────────────────

func (s *AISvc) AdjustChunkBoundary(
	ctx context.Context,
	req *richterv1.AdjustChunkBoundaryRequest,
) (*richterv1.AdjustChunkBoundaryResponse, error) {
	result, err := s.chunkOps.AdjustBoundary(ctx, req)
	if err != nil {
		return nil, err
	}
	return &richterv1.AdjustChunkBoundaryResponse{
		PrevChunk: chunkToProto(result.Prev),
		NextChunk: chunkToProto(result.Next),
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

// ── Step 7: GenerateInteractionsStream ───────────────────────────────────────
//
// GenerateInteractionsStream was removed in this revision. The generation
// step is now triggered via StartLessonTask with kind =
// LESSON_TASK_KIND_GENERATE_INTERACTIONS. The underlying pipeline
// (runGenerateInteractions below) is still used by the task worker — see
// task_runner.go.

// generateInteractionsProgressFn is the new typed callback used by the
// task worker. We no longer wrap it in a *GenerateInteractionsProgressEvent
// (the proto type was removed) — we emit each field directly.
type generateInteractionsProgressFn func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error

func (s *AISvc) runGenerateInteractions(
	ctx context.Context,
	lessonID pgtype.UUID,
	req *richterv1.GenerateInteractionsRequest,
	send generateInteractionsProgressFn,
) error {
	return s.generation.Run(ctx, lessonID, req, func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error {
		return send(step, msg, chunkIndex, totalChunks)
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
