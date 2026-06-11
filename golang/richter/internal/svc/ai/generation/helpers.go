package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultGenerationCount = 2

type kindCount struct {
	kind  richterv1.InteractionKind
	count int32
}

type generationPlan struct {
	useAIChoose bool
	aiKinds     []richterv1.InteractionKind
	aiCount     int32
	evenCounts  []kindCount
}

type aiChooseKindSpec struct {
	kindStr   string
	generator svcinteractions.GeminiGenerator
}

type generatedItem struct {
	prompt      string
	explanation string
	startSecs   float32
	configJSON  []byte
	kindStr     string
}

type interactionConfigJSON struct {
	Count    int32    `json:"count,omitempty"`
	Kinds    []string `json:"kinds,omitempty"`
	Strategy string   `json:"strategy,omitempty"`
}

func aiCtx(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, d)
}

func interactionConfigFromJSON(data []byte) *richterv1.ChunkInteractionConfig {
	if len(data) == 0 {
		return nil
	}
	var raw interactionConfigJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	if raw.Count == 0 && len(raw.Kinds) == 0 && raw.Strategy == "" {
		return nil
	}
	kinds := make([]richterv1.InteractionKind, 0, len(raw.Kinds))
	for _, ks := range raw.Kinds {
		k := svcinteractions.DBStringToKind(ks)
		if k != richterv1.InteractionKind_INTERACTION_KIND_UNSPECIFIED {
			kinds = append(kinds, k)
		}
	}
	strategy := richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED
	switch raw.Strategy {
	case "ai_choose":
		strategy = richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE
	case "even":
		strategy = richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION
	}
	return &richterv1.ChunkInteractionConfig{
		Count:    raw.Count,
		Kinds:    kinds,
		Strategy: strategy,
	}
}

func interactionGenerationBatchSize(kind richterv1.InteractionKind) int32 {
	switch kind {
	case richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
		richterv1.InteractionKind_INTERACTION_KIND_READING:
		return 1
	default:
		return 4
	}
}

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

	if len(reqKinds) > 0 {
		cfgKinds = reqKinds
	}
	if reqCount > 0 {
		cfgCount = reqCount
	}
	if reqStrategy != richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED {
		cfgStrategy = reqStrategy
	}

	if len(cfgKinds) == 0 {
		cfgKinds = []richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE}
	}
	if cfgCount <= 0 {
		cfgCount = defaultGenerationCount
	}

	if cfgStrategy != richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION {
		return generationPlan{useAIChoose: true, aiKinds: cfgKinds, aiCount: cfgCount}
	}

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
		`Bạn là chuyên gia thiết kế câu hỏi giáo dục. Nhiệm vụ: tạo %d bài tập CHẤT LƯỢNG CAO từ đoạn bài giảng dưới đây.

MỤC TIÊU: Mỗi bài tập phải đo lường HIỂU BIẾT THỰC SỰ — không chỉ nhớ từ ngữ. Người học phải suy nghĩ, không thể đoán mò.

TIÊU CHÍ CHẤT LƯỢNG (bắt buộc):
1. BÁM SÁT NỘI DUNG: câu hỏi/bài tập phải xuất phát từ ý tưởng CỐT LÕI của đoạn — không phải chi tiết ngoại vi.
2. YÊU CẦU SUY LUẬN: hỏi về nguyên nhân, hệ quả, so sánh, ứng dụng — không chỉ tái hiện định nghĩa nguyên văn.
3. PHÂN BIỆT RÕ: người học biết kiến thức phải trả lời đúng; người chưa học không thể đoán mò.
4. explanation HỮU ÍCH: giải thích liên hệ lại với khái niệm trong bài.

%sVới mỗi bài tập, chọn loại PHÙ HỢP NHẤT với nội dung muốn kiểm tra từ các loại cho phép:
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

func extractStatusCode(msg string) string {
	for _, code := range []string{"503", "429", "500", "502", "504"} {
		if strings.Contains(msg, code) {
			return code
		}
	}
	return "rate limit"
}

func friendlyGeminiError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
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
	if strings.HasPrefix(raw, "```") {
		if after, found := strings.CutPrefix(raw, "```json"); found {
			raw = after
		} else {
			raw, _ = strings.CutPrefix(raw, "```")
		}
		if idx := strings.LastIndex(raw, "\n```"); idx != -1 {
			raw = raw[:idx]
		} else if idx := strings.LastIndex(raw, "```"); idx != -1 {
			raw = raw[:idx]
		}
		raw = strings.TrimSpace(raw)
	}
	return raw, nil
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

func (s *Service) insertInteractionsInTx(ctx context.Context, q *gen.Queries, lessonID, chunkID pgtype.UUID, items []generatedItem) ([]gen.LessonInteraction, error) {
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

func (s *Service) saveInteractionsForChunk(ctx context.Context, lessonID pgtype.UUID, chunkID pgtype.UUID, items []generatedItem) ([]gen.LessonInteraction, error) {
	return db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) ([]gen.LessonInteraction, error) {
		return s.insertInteractionsInTx(ctx, q, lessonID, chunkID, items)
	})
}

func (s *Service) ReplaceInteractionWithGeneratedItem(
	ctx context.Context,
	interactionID pgtype.UUID,
	item generatedItem,
) (gen.LessonInteraction, error) {
	return db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.ReplaceInteraction(ctx, gen.ReplaceInteractionParams{
			ID:          interactionID,
			Kind:        item.kindStr,
			Prompt:      item.prompt,
			Explanation: item.explanation,
			Config:      item.configJSON,
		})
	})
}
