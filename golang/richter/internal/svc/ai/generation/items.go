package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

func (s *Service) GenerateItems(
	ctx context.Context,
	client *genai.Client,
	chunk gen.LessonTranscriptChunk,
	transcript string,
	generator svcinteractions.GeminiGenerator,
	kindStr string,
	lessonLanguage string,
	difficulty string,
	focusPrompt string,
) ([]generatedItem, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.SetTemperature(0.3)
	model.ResponseMIMEType = "application/json"
	model.SetMaxOutputTokens(65536)

	var customInstructions strings.Builder
	if difficulty != "" {
		fmt.Fprintf(&customInstructions, "Mức độ khó của câu hỏi PHẢI là: %s.\n", difficulty)
	}
	if focusPrompt != "" {
		fmt.Fprintf(&customInstructions, "Tập trung vào yêu cầu/chủ đề sau khi tạo câu hỏi: %s.\n", focusPrompt)
	}
	fmt.Fprintf(&customInstructions, "%s\n", strongLanguageInstruction(lessonLanguage))

	prompt := fmt.Sprintf(`Bạn là chuyên gia thiết kế câu hỏi giáo dục. Nhiệm vụ: tạo %d bài tập CHẤT LƯỢNG CAO từ đoạn bài giảng dưới đây.

MỤC TIÊU: Mỗi bài tập phải đo lường HIỂU BIẾT THỰC SỰ — không chỉ nhớ từ ngữ. Người học phải suy nghĩ, không thể đoán mò.

TIÊU CHÍ CHẤT LƯỢNG (bắt buộc với mỗi bài tập):
1. BÁM SÁT NỘI DUNG: câu hỏi/bài tập phải xuất phát từ ý tưởng CỐT LÕI của đoạn — không phải chi tiết ngoại vi.
2. YÊU CẦU SUY LUẬN: hỏi về nguyên nhân, hệ quả, so sánh, ứng dụng, hoặc tổng hợp — không chỉ tái hiện định nghĩa nguyên văn.
3. PHÂN BIỆT RÕ: người học biết kiến thức phải trả lời đúng; người chưa học không thể đoán.
4. explanation HỮU ÍCH: giải thích liên hệ lại với khái niệm trong bài, không chỉ lặp lại đáp án.

%s
%s
Đoạn nội dung (%.1f - %.1f giây):
%s

start_seconds PHẢI bằng thời điểm kết thúc đoạn: %.1f giây.

Mỗi item trong mảng "items" phải tuân theo JSON schema sau:
%s

Trả về JSON object: {"items": [...]}`,
		chunk.QuestionCountConfig,
		generator.GeminiPromptHint(),
		customInstructions.String(),
		float32(chunk.StartSeconds), float32(chunk.EndSeconds),
		transcript,
		float32(chunk.EndSeconds),
		generator.GeminiSchema(),
	)

	s.log.InfoContext(ctx, "[GEMINI] GenerateItems: calling GenerateContent", "chunk_id", chunk.ID.String(), "chunk_index", chunk.OrderIndex)
	resp, err := model.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		return nil, friendlyGeminiError(fmt.Errorf("generate content: %w", err))
	}

	raw, err := geminiResponseText(resp)
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("parse gemini response: %w", err)
	}

	items := make([]generatedItem, 0, len(result.Items))
	for i, rawItem := range result.Items {
		if chunk.QuestionCountConfig > 0 && len(items) >= int(chunk.QuestionCountConfig) {
			break
		}
		prompt, explanation, _, configJSON, err := generator.ParseGeminiItem(rawItem)
		if err != nil {
			s.log.WarnContext(ctx, "ai: skipping item that failed validation", "index", i, "err", err)
			continue
		}
		startSecs := generatedInteractionCheckpointSeconds(chunk)
		if ttsProv, ok := generator.(svcinteractions.TTSProvider); ok {
			if text := ttsProv.AudioSourceText(configJSON); text != "" {
				configJSON, err = s.embedAudio(ctx, ttsProv, configJSON, text, lessonLanguage, chunk.LessonID.String())
				if err != nil {
					s.log.WarnContext(ctx, "ai: TTS synthesis failed, skipping item", "index", i, "err", err)
					continue
				}
			}
		}
		items = append(items, generatedItem{
			prompt:      prompt,
			explanation: explanation,
			startSecs:   startSecs,
			configJSON:  configJSON,
			kindStr:     kindStr,
		})
	}
	return items, nil
}

func (s *Service) GenerateItemsAIChoose(
	ctx context.Context,
	client *genai.Client,
	chunk gen.LessonTranscriptChunk,
	transcript string,
	allowedKinds []richterv1.InteractionKind,
	totalCount int32,
	lessonLanguage string,
	difficulty string,
	focusPrompt string,
) ([]generatedItem, error) {
	specs := make([]aiChooseKindSpec, 0, len(allowedKinds))
	for _, k := range allowedKinds {
		h := svcinteractions.Get(k)
		if h == nil {
			s.log.WarnContext(ctx, "ai-choose: no handler for kind, skipping", "kind", k)
			continue
		}
		g, ok := h.(svcinteractions.GeminiGenerator)
		if !ok {
			s.log.WarnContext(ctx, "ai-choose: kind has no Gemini generator, skipping", "kind", k)
			continue
		}
		specs = append(specs, aiChooseKindSpec{kindStr: svcinteractions.KindToDBString(k), generator: g})
	}
	if len(specs) == 0 {
		return nil, fmt.Errorf("no supported kinds in allowedKinds")
	}
	if len(specs) == 1 {
		chunkCopy := chunk
		chunkCopy.QuestionCountConfig = totalCount
		return s.GenerateItems(ctx, client, chunkCopy, transcript, specs[0].generator, specs[0].kindStr, lessonLanguage, difficulty, focusPrompt)
	}

	prompt := buildAIChoosePrompt(chunk, transcript, totalCount, specs, difficulty, focusPrompt, lessonLanguage)
	ctx, cancel := aiCtx(ctx, s.aiCfg.InteractionGenTimeout)
	defer cancel()

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.SetTemperature(0.3)
	model.ResponseMIMEType = "application/json"
	model.SetMaxOutputTokens(65536)

	s.log.InfoContext(ctx, "[GEMINI] GenerateItemsAIChoose: calling GenerateContent",
		"chunk_id", chunk.ID.String(), "chunk_index", chunk.OrderIndex, "kinds", len(specs), "count", totalCount)
	resp, err := model.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		return nil, friendlyGeminiError(fmt.Errorf("generate content: %w", err))
	}

	raw, err := geminiResponseText(resp)
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("parse gemini response: %w", err)
	}

	handlerByKind := make(map[string]svcinteractions.GeminiGenerator, len(specs))
	kindAllowed := make(map[string]bool, len(specs))
	for _, sp := range specs {
		handlerByKind[sp.kindStr] = sp.generator
		kindAllowed[sp.kindStr] = true
	}

	items := make([]generatedItem, 0, len(result.Items))
	for i, rawItem := range result.Items {
		if totalCount > 0 && len(items) >= int(totalCount) {
			break
		}
		var kindHolder struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(rawItem, &kindHolder); err != nil || kindHolder.Kind == "" {
			s.log.WarnContext(ctx, "ai-choose: item missing kind field, skipping", "index", i)
			continue
		}
		if !kindAllowed[kindHolder.Kind] {
			s.log.WarnContext(ctx, "ai-choose: item has disallowed kind, skipping", "index", i, "kind", kindHolder.Kind)
			continue
		}
		handler := handlerByKind[kindHolder.Kind]
		prompt, explanation, _, configJSON, parseErr := handler.ParseGeminiItem(rawItem)
		if parseErr != nil {
			s.log.WarnContext(ctx, "ai-choose: skipping item that failed validation", "index", i, "kind", kindHolder.Kind, "err", parseErr)
			continue
		}
		startSecs := generatedInteractionCheckpointSeconds(chunk)
		if ttsProv, ok := handler.(svcinteractions.TTSProvider); ok {
			if text := ttsProv.AudioSourceText(configJSON); text != "" {
				configJSON, parseErr = s.embedAudio(ctx, ttsProv, configJSON, text, lessonLanguage, chunk.LessonID.String())
				if parseErr != nil {
					s.log.WarnContext(ctx, "ai-choose: TTS synthesis failed, skipping item", "index", i, "kind", kindHolder.Kind, "err", parseErr)
					continue
				}
			}
		}
		items = append(items, generatedItem{
			prompt:      prompt,
			explanation: explanation,
			startSecs:   startSecs,
			configJSON:  configJSON,
			kindStr:     kindHolder.Kind,
		})
	}
	return items, nil
}

func newGeminiClient(ctx context.Context, cfg *cfg.GeminiCfg) (*genai.Client, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("Gemini API key not configured (set RICHTER_GEMINI_API_KEY or gemini.api_key in config)")
	}
	c, err := genai.NewClient(ctx, option.WithAPIKey(cfg.APIKey))
	if err != nil {
		return nil, fmt.Errorf("create gemini client: %w", err)
	}
	return c, nil
}
