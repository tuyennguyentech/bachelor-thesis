package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc/ai/genengine"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
)

func (s *Service) GenerateItems(
	ctx context.Context,
	chunk gen.LessonTranscriptChunk,
	transcript string,
	generator svcinteractions.GeminiGenerator,
	kindStr string,
	lessonLanguage string,
	difficulty string,
	focusPrompt string,
) ([]generatedItem, error) {
	if s.aiCfg.InteractionGenTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.aiCfg.InteractionGenTimeout)
		defer cancel()
	}

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

start_seconds PHẢI đặt câu hỏi ngay TRƯỚC khi kết thúc đoạn, tại khoảng %.1f giây (không được bằng hoặc vượt quá thời điểm kết thúc đoạn).

Mỗi item trong mảng "items" phải tuân theo JSON schema sau:
%s

Trả về JSON object: {"items": [...]}`,
		chunk.QuestionCountConfig,
		generator.GeminiPromptHint(),
		customInstructions.String(),
		float32(chunk.StartSeconds), float32(chunk.EndSeconds),
		transcript,
		generatedInteractionCheckpointSeconds(chunk),
		generator.GeminiSchema(),
	)

	// One generation attempt: ask the engine (real Gemini or mock), parse, and
	// build validated items.
	genOnce := func() ([]generatedItem, error) {
		raw, err := s.engine.Generate(ctx, genengine.Request{
			Prompt:          prompt,
			Temperature:     0.3,
			MaxOutputTokens: 65536,
			JSONOutput:      true,
			Purpose:         genengine.ItemsPurpose(kindStr),
		})
		if err != nil {
			return nil, friendlyGeminiError(err)
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

	// Retry transient failures, degraded-empty results, AND UNDER-DELIVERY with
	// linear backoff. Under-delivery matters for kinds that fail validation/TTS
	// more often (listening especially): a batch that should yield N items but
	// returns fewer (because some were dropped) used to be accepted as-is — the
	// chief cause of "listening exercises frequently missing" when an explicit
	// per-kind count was requested. We now retry until the target count is met,
	// keeping the BEST (largest) attempt so a later thinner attempt never loses
	// items. An empty transcript legitimately yields 0.
	attempts := max(s.aiCfg.GeminiMaxAttempts, 1)
	transcriptEmpty := strings.TrimSpace(transcript) == ""
	target := int(chunk.QuestionCountConfig)
	s.log.InfoContext(ctx, "[GEMINI] GenerateItems: calling GenerateContent", "chunk_id", chunk.ID.String(), "chunk_index", chunk.OrderIndex)
	var best []generatedItem
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		items, err := genOnce()
		if err == nil {
			if len(items) > len(best) {
				best = items
			}
			// Done once we meet the target (or there's no target / empty transcript).
			if transcriptEmpty || target <= 0 || len(best) >= target {
				return best, nil
			}
		}
		lastErr = err
		// Retry on transient errors and on any non-error short delivery.
		retryable := isTransientGeminiError(err) || err == nil
		if !retryable || attempt == attempts {
			if len(best) > 0 {
				// Exhausted attempts but have a partial set — return it rather than
				// failing the whole chunk (some questions beat none).
				return best, nil
			}
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, fmt.Errorf("Gemini API trả về 0 câu hỏi sau %d lần thử (có thể do vượt quota / quá tải). Vui lòng thử lại sau.", attempts)
		}
		s.log.WarnContext(ctx, "[GEMINI] GenerateItems: under-target/transient result, retrying",
			"attempt", attempt, "max", attempts, "items", len(best), "target", target, "err", err)
		select {
		case <-ctx.Done():
			if len(best) > 0 {
				return best, nil
			}
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * s.aiCfg.GeminiRetryBackoff):
		}
	}
	return best, nil
}

func (s *Service) GenerateItemsAIChoose(
	ctx context.Context,
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
		return s.GenerateItems(ctx, chunkCopy, transcript, specs[0].generator, specs[0].kindStr, lessonLanguage, difficulty, focusPrompt)
	}

	prompt := buildAIChoosePrompt(chunk, transcript, totalCount, specs, difficulty, focusPrompt, lessonLanguage)
	ctx, cancel := aiCtx(ctx, s.aiCfg.InteractionGenTimeout)
	defer cancel()

	handlerByKind := make(map[string]svcinteractions.GeminiGenerator, len(specs))
	kindAllowed := make(map[string]bool, len(specs))
	for _, sp := range specs {
		handlerByKind[sp.kindStr] = sp.generator
		kindAllowed[sp.kindStr] = true
	}

	// One generation attempt: ask the engine, parse, build validated items
	// (synthesising TTS audio where the kind requires it).
	genOnce := func() ([]generatedItem, error) {
		raw, err := s.engine.Generate(ctx, genengine.Request{
			Prompt:          prompt,
			Temperature:     0.3,
			MaxOutputTokens: 65536,
			JSONOutput:      true,
			Purpose:         genengine.PurposeItemsAIChoose,
		})
		if err != nil {
			return nil, friendlyGeminiError(err)
		}
		var result struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			return nil, fmt.Errorf("parse gemini response: %w", err)
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

	// Retry transient failures / degraded-empty results, exactly like the
	// single-kind GenerateItems path. Without this, a single AI_CHOOSE call whose
	// only listening item failed validation or whose response was throttled
	// dropped the kind with no recovery — the chief cause of "listening exercises
	// frequently missing". A non-empty chunk that yields 0 items is retried; an
	// empty transcript legitimately yields 0.
	attempts := max(s.aiCfg.GeminiMaxAttempts, 1)
	transcriptEmpty := strings.TrimSpace(transcript) == ""
	s.log.InfoContext(ctx, "[GENAI] GenerateItemsAIChoose: generating",
		"engine", s.engine.Name(), "chunk_id", chunk.ID.String(), "chunk_index", chunk.OrderIndex, "kinds", len(specs), "count", totalCount)
	var items []generatedItem
	for attempt := 1; attempt <= attempts; attempt++ {
		var err error
		items, err = genOnce()
		if err == nil && (len(items) > 0 || transcriptEmpty) {
			return items, nil
		}
		retryable := isTransientGeminiError(err) || (err == nil && len(items) == 0)
		if !retryable || attempt == attempts {
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("Gemini API trả về 0 câu hỏi sau %d lần thử (có thể do vượt quota / quá tải). Vui lòng thử lại sau.", attempts)
		}
		s.log.WarnContext(ctx, "[GENAI] GenerateItemsAIChoose: transient/empty result, retrying",
			"attempt", attempt, "max", attempts, "items", len(items), "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * s.aiCfg.GeminiRetryBackoff):
		}
	}
	return items, nil
}
