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
	Mode            string `json:"mode"`
	PassageMarkdown string `json:"passage_markdown"`
	Question        string `json:"question,omitempty"`
}

type readingResponseJSON struct {
	AudioObjectKey string `json:"audio_object_key"`
}

type readingHandler struct{}

func (h *readingHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_READING
}

func (h *readingHandler) Grade(_, _ []byte) (score, maxScore float32, feedback string, err error) {
	// Full Gemini audio grading is implemented via ContextualGrader in STEP 4.
	// This stub awards full score so non-audio submissions don't block grading.
	return 1, 1, "", nil
}

func (h *readingHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	rr, ok := req.Response.(*richterv1.AttemptResponseInput_Reading)
	if !ok || rr == nil || rr.Reading == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: missing reading response"))
	}
	return json.Marshal(readingResponseJSON{AudioObjectKey: rr.Reading.AudioObjectKey})
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
			Reading: &richterv1.ReadingResponse{AudioObjectKey: resp.AudioObjectKey},
		}
	}
	return r
}

func (h *readingHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, _ bool) bool {
	var cfg readingConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	mode := readingModeFromString(cfg.Mode)
	p.Config = &richterv1.LessonInteraction_Reading{
		Reading: &richterv1.ReadingConfig{
			Mode:            mode,
			PassageMarkdown: cfg.PassageMarkdown,
			Question:        cfg.Question,
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
	if rc.Mode == richterv1.ReadingMode_READING_MODE_OPEN_ANSWER && strings.TrimSpace(rc.Question) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("reading: question required for open_answer mode"))
	}
	return json.Marshal(readingConfigJSON{
		Mode:            readingModeToString(rc.Mode),
		PassageMarkdown: rc.PassageMarkdown,
		Question:        rc.Question,
	})
}

func readingModeToString(m richterv1.ReadingMode) string {
	switch m {
	case richterv1.ReadingMode_READING_MODE_OPEN_ANSWER:
		return "open_answer"
	default:
		return "pronunciation"
	}
}

func readingModeFromString(s string) richterv1.ReadingMode {
	switch s {
	case "open_answer":
		return richterv1.ReadingMode_READING_MODE_OPEN_ANSWER
	default:
		return richterv1.ReadingMode_READING_MODE_PRONUNCIATION
	}
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

type readingGeminiItem struct {
	Prompt          string  `json:"prompt"`
	Explanation     string  `json:"explanation"`
	StartSeconds    float32 `json:"start_seconds"`
	Mode            string  `json:"mode"`
	PassageMarkdown string  `json:"passage_markdown"`
	Question        string  `json:"question,omitempty"`
}

func (h *readingHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["prompt","mode","passage_markdown","start_seconds"],
  "properties": {
    "prompt":           {"type": "string"},
    "explanation":      {"type": "string"},
    "start_seconds":    {"type": "number"},
    "mode":             {"type": "string", "enum": ["pronunciation", "open_answer"]},
    "passage_markdown": {"type": "string", "minLength": 20},
    "question":         {"type": "string"}
  }
}`
}

func (h *readingHandler) GeminiPromptHint() string {
	return `Tạo bài đọc âm thanh. Với mode "pronunciation": viết đoạn văn ngắn (50-150 từ) tóm tắt nội dung transcript để học viên đọc to. Với mode "open_answer": viết câu hỏi mở và đoạn văn ngữ cảnh để học viên trả lời bằng lời nói.`
}

func (h *readingHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item readingGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("reading: parse gemini item: %w", err)
	}
	if strings.TrimSpace(item.PassageMarkdown) == "" {
		return "", "", 0, nil, fmt.Errorf("reading: passage_markdown empty")
	}
	if item.Mode == "open_answer" && strings.TrimSpace(item.Question) == "" {
		return "", "", 0, nil, fmt.Errorf("reading: question empty for open_answer mode")
	}
	if item.Mode != "pronunciation" && item.Mode != "open_answer" {
		item.Mode = "pronunciation"
	}
	configJSON, err = json.Marshal(readingConfigJSON{
		Mode:            item.Mode,
		PassageMarkdown: item.PassageMarkdown,
		Question:        item.Question,
	})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.Prompt, item.Explanation, item.StartSeconds, configJSON, nil
}
