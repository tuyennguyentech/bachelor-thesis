package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
)

type audioEmbedFunc func(
	ctx context.Context,
	ttsProv svcinteractions.TTSProvider,
	configJSON []byte,
	text string,
	lessonLanguage string,
	lessonID string,
) ([]byte, error)

type interactionGenerationService struct {
	geminiCfg  *cfg.GeminiCfg
	log        *log.LogSvc
	embedAudio audioEmbedFunc
}

func newInteractionGenerationService(
	geminiCfg *cfg.GeminiCfg,
	logSvc *log.LogSvc,
	embedAudio audioEmbedFunc,
) *interactionGenerationService {
	return &interactionGenerationService{geminiCfg: geminiCfg, log: logSvc, embedAudio: embedAudio}
}

// runGeminiGenerateItems calls Gemini using the provided GeminiGenerator interface
// and returns a list of generatedItem parsed from the response.
// lessonLanguage is used by TTSProvider handlers to synthesise audio.
func (s *interactionGenerationService) runGeminiGenerateItems(
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
	// gemini-3.1-flash-lite max output is 65536. The previous 16384 limit caused
	// FinishReasonMaxTokens for listening items (1-4 nested MCQ with audio_source_text)
	// and any batch with >2 reasoning-heavy kinds. See geminiResponseText for the
	// user-facing error.
	model.SetMaxOutputTokens(65536)

	var customInstructions strings.Builder
	if difficulty != "" {
		fmt.Fprintf(&customInstructions, "Mức độ khó của câu hỏi PHẢI là: %s.\n", difficulty)
	}
	if focusPrompt != "" {
		fmt.Fprintf(&customInstructions, "Tập trung vào yêu cầu/chủ đề sau khi tạo câu hỏi: %s.\n", focusPrompt)
	}
	fmt.Fprintf(&customInstructions, "%s\n", strongLanguageInstruction(lessonLanguage))

	prompt := fmt.Sprintf(`Bạn là trợ lý giáo dục. Dựa trên đoạn nội dung bài giảng sau, hãy tạo %d bài tập để kiểm tra hiểu biết của học sinh.
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

// runGeminiGenerateItemsAIChoose calls Gemini with a union prompt for AI_CHOOSE mode.
// The model picks the most appropriate kind for each item from allowedKinds.
// Items with disallowed or invalid kinds are skipped with a warning.
func (s *interactionGenerationService) runGeminiGenerateItemsAIChoose(
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
	// Build kind specs (skip kinds with no GeminiGenerator support).
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
	// Fallback to even-distribution if only one kind (simpler, same result).
	if len(specs) == 1 {
		chunkCopy := chunk
		chunkCopy.QuestionCountConfig = totalCount
		return s.runGeminiGenerateItems(ctx, client, chunkCopy, transcript, specs[0].generator, specs[0].kindStr, lessonLanguage, difficulty, focusPrompt)
	}

	prompt := buildAIChoosePrompt(chunk, transcript, totalCount, specs, difficulty, focusPrompt, lessonLanguage)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
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

	// Build fast-lookup maps.
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
