package interactions

import (
	"encoding/json"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
)

func init() {
	registerHandler(&readingHandler{})
}

type readingConfigJSON struct {
	PassageMarkdown string                `json:"passage_markdown"`
	Questions       []nestedMcqConfigJSON `json:"questions"`
}

type readingResponseJSON struct {
	Answers []int32 `json:"answers"`
}

type readingHandler struct{}

func (h *readingHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_READING
}

func (h *readingHandler) Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg readingConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("reading: unmarshal config: %w", err)
	}
	var resp readingResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("reading: unmarshal response: %w", err)
	}

	configs := make([]*richterv1.McqConfig, 0, len(cfg.Questions))
	for _, q := range cfg.Questions {
		opts := make([]*richterv1.McqOption, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, &richterv1.McqOption{Text: o})
		}
		configs = append(configs, &richterv1.McqConfig{
			Options:       opts,
			CorrectAnswer: int32(q.CorrectAnswer),
		})
	}
	correct, total, _ := gradeMcqList(configs, resp.Answers)
	return float32(correct), float32(total), "", nil
}

func (h *readingHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	rr, ok := req.Response.(*richterv1.AttemptResponseInput_Reading)
	if !ok || rr == nil || rr.Reading == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: missing reading response"))
	}
	return json.Marshal(readingResponseJSON{Answers: rr.Reading.Answers})
}

func (h *readingHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp readingResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		r.Response = &richterv1.LessonAttemptResponse_Reading{
			Reading: &richterv1.ReadingResponse{Answers: resp.Answers},
		}
	}
	return r
}

func (h *readingHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg readingConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	p.Config = &richterv1.LessonInteraction_Reading{
		Reading: &richterv1.ReadingConfig{
			PassageMarkdown: cfg.PassageMarkdown,
			Questions:       mcqConfigsFromJSON(cfg.Questions, stripAnswers),
		},
	}
	return true
}

func (h *readingHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	rc, ok := req.Config.(*richterv1.CreateManualInteractionRequest_Reading)
	if !ok || rc == nil || rc.Reading == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: missing config"))
	}
	return h.protoToJSON(rc.Reading)
}

func (h *readingHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	rc, ok := req.Config.(*richterv1.UpdateInteractionRequest_Reading)
	if !ok || rc == nil || rc.Reading == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: missing config"))
	}
	return h.protoToJSON(rc.Reading)
}

func (h *readingHandler) protoToJSON(rc *richterv1.ReadingConfig) ([]byte, error) {
	if strings.TrimSpace(rc.PassageMarkdown) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: passage_markdown required"))
	}
	if err := validateMcqList(rc.Questions); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: %w", err))
	}
	questions, err := mcqConfigsToJSON(rc.Questions)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return json.Marshal(readingConfigJSON{
		PassageMarkdown: rc.PassageMarkdown,
		Questions:       questions,
	})
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

type readingGeminiItem struct {
	Prompt          string               `json:"prompt"`
	Explanation     string               `json:"explanation"`
	StartSeconds    float32              `json:"start_seconds"`
	PassageMarkdown string               `json:"passage_markdown"`
	Questions       []mcqGeminiItemNested `json:"questions"`
}

func (h *readingHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["prompt","passage_markdown","questions","start_seconds"],
  "properties": {
    "prompt":           {"type": "string"},
    "explanation":      {"type": "string"},
    "start_seconds":    {"type": "number"},
    "passage_markdown": {"type": "string"},
    "questions": {
      "type": "array", "minItems": 2, "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["options","correct_answer"],
        "properties": {
          "options":        {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
          "correct_answer": {"type": "integer"}
        }
      }
    }
  }
}`
}

func (h *readingHandler) GeminiPromptHint() string {
	return `Tạo bài đọc hiểu. Viết đoạn văn ngắn (passage_markdown) tóm tắt nội dung từ transcript, sau đó tạo 2-4 câu hỏi MCQ về đoạn văn đó.`
}

func (h *readingHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item readingGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("reading: parse gemini item: %w", err)
	}
	if strings.TrimSpace(item.PassageMarkdown) == "" {
		return "", "", 0, nil, fmt.Errorf("reading: passage_markdown empty")
	}
	questions := make([]nestedMcqConfigJSON, 0, len(item.Questions))
	for i, q := range item.Questions {
		if q.CorrectAnswer < 0 || q.CorrectAnswer >= len(q.Options) {
			return "", "", 0, nil, fmt.Errorf("reading: question %d: correct_answer out of range", i)
		}
		questions = append(questions, nestedMcqConfigJSON{Options: q.Options, CorrectAnswer: q.CorrectAnswer})
	}
	configJSON, err = json.Marshal(readingConfigJSON{
		PassageMarkdown: item.PassageMarkdown,
		Questions:       questions,
	})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.Prompt, item.Explanation, item.StartSeconds, configJSON, nil
}
