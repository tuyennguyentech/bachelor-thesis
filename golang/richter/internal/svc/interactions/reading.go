package interactions

import (
	"context"
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
	ExpectedAnswer  string `json:"expected_answer,omitempty"`
}

type readingResponseJSON struct {
	AudioObjectKey string `json:"audio_object_key"`
}

type readingHandler struct{}

func (h *readingHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_READING
}

func (h *readingHandler) Grade(_, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	// Fallback when GradingDeps not available (unit tests, missing AI config).
	// Return score=0 (not 1) so that the fallback path does not award a perfect
	// score for an ungraded submission — callers should see a no-submission result.
	var resp readingResponseJSON
	if len(responseJSON) > 0 {
		_ = json.Unmarshal(responseJSON, &resp)
	}
	if strings.TrimSpace(resp.AudioObjectKey) == "" {
		return 0, 1, "Chưa có bản ghi âm.", nil
	}
	// Audio key present but no AI context to grade: pending credit.
	return 0, 1, "Chưa chấm điểm — hệ thống AI chưa được cấu hình.", nil
}

// GradeWithContext implements ContextualGrader — used by SubmitAttempt when AISvc is wired.
func (h *readingHandler) GradeWithContext(ctx context.Context, deps GradingDeps, configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg readingConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("reading: unmarshal config: %w", err)
	}
	var resp readingResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("reading: unmarshal response: %w", err)
	}
	if strings.TrimSpace(resp.AudioObjectKey) == "" {
		return 0, 1, "Chưa có bản ghi âm.", nil
	}

	audioBytes, err := deps.GetAudioBytes(ctx, resp.AudioObjectKey)
	if err != nil {
		// Symmetric with the Gemini fallback in grading_deps.go: an S3 hiccup must
		// not 500 the whole grade request, otherwise the student sees a hard error
		// for what is really a transient infra issue. Pending credit + teacher
		// review keeps the lesson flow alive.
		return 0.5, 1.0, "Hệ thống chưa tải được bản ghi âm để chấm. Giáo viên sẽ xem lại.", nil
	}

	return deps.GradeAudio(ctx, audioBytes, cfg.PassageMarkdown, cfg.Question, cfg.ExpectedAnswer)
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

func (h *readingHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg readingConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	rc := &richterv1.ReadingConfig{
		Mode:            readingModeFromString(cfg.Mode),
		PassageMarkdown: cfg.PassageMarkdown,
		Question:        cfg.Question,
	}
	if !stripAnswers {
		rc.ExpectedAnswer = cfg.ExpectedAnswer
	}
	p.Config = &richterv1.LessonInteraction_Reading{Reading: rc}
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
	cfg := readingConfigJSON{
		Mode:            readingModeToString(rc.Mode),
		PassageMarkdown: rc.PassageMarkdown,
		Question:        rc.Question,
	}
	if rc.Mode == richterv1.ReadingMode_READING_MODE_OPEN_ANSWER {
		cfg.ExpectedAnswer = rc.ExpectedAnswer
	}
	return json.Marshal(cfg)
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

func (h *readingHandler) AudioObjectKeyFromResponse(responseJSON []byte) string {
	var resp readingResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err != nil {
		return ""
	}
	return resp.AudioObjectKey
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

type readingGeminiItem struct {
	Prompt          string  `json:"prompt"`
	Explanation     string  `json:"explanation"`
	StartSeconds    float32 `json:"start_seconds"`
	Mode            string  `json:"mode"`
	PassageMarkdown string  `json:"passage_markdown"`
	Question        string  `json:"question,omitempty"`
	ExpectedAnswer  string  `json:"expected_answer,omitempty"`
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
    "question":         {"type": "string"},
    "expected_answer":  {"type": "string"}
  }
}`
}

func (h *readingHandler) GeminiPromptHint() string {
	return `Tạo bài đọc (reading) có giá trị học tập rõ ràng — không chỉ tái hiện lại câu từ transcript.

Chọn mode phù hợp:

MODE "open_answer" (ĐƯỢC ƯU TIÊN khi đoạn transcript có nội dung phong phú):
- passage_markdown: đoạn văn 80–200 từ trình bày khái niệm/lý thuyết từ bài giảng, viết lại ở dạng mạch lạc (không copy nguyên văn transcript nếu transcript là lời nói tự nhiên). Được phép dùng markdown đơn giản (in đậm thuật ngữ, gạch đầu dòng).
- question: câu hỏi đọc hiểu YÊU CẦU TƯ DUY, ví dụ: "Theo đoạn văn, điểm khác biệt chính giữa X và Y là gì?", "Giải thích bằng lời của bạn tại sao …", "Liệt kê 2 ví dụ được đề cập và giải thích vai trò của chúng."
- expected_answer: câu trả lời mẫu ngắn gọn (1–3 câu), đủ để hệ thống AI chấm điểm ngữ nghĩa (không phải đáp án duy nhất — phục vụ tham chiếu).
- CẤM: câu hỏi mà câu trả lời được nhìn thấy ngay lập tức khi đọc lướt passage.

MODE "pronunciation" (dùng khi đoạn transcript chứa nhiều thuật ngữ kỹ thuật hoặc cấu trúc ngôn ngữ cần luyện phát âm):
- passage_markdown: đoạn văn 60–150 từ, mật độ thuật ngữ vừa phải, câu đa dạng về độ dài và cấu trúc để thử thách khả năng đọc.
- question và expected_answer: để trống (không cần cho pronunciation mode).

prompt: hướng dẫn rõ cho người học (ví dụ: "Đọc to đoạn văn sau:" hoặc "Đọc đoạn văn và trả lời câu hỏi bằng giọng nói:").
explanation: giải thích mục tiêu học tập của bài đọc này (ví dụ: thuật ngữ nào cần nắm, khái niệm gì được kiểm tra).`
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
	if item.Mode == "open_answer" && strings.TrimSpace(item.ExpectedAnswer) == "" {
		return "", "", 0, nil, fmt.Errorf("reading: expected_answer empty for open_answer mode")
	}
	if item.Mode != "pronunciation" && item.Mode != "open_answer" {
		item.Mode = "pronunciation"
	}
	configJSON, err = json.Marshal(readingConfigJSON{
		Mode:            item.Mode,
		PassageMarkdown: item.PassageMarkdown,
		Question:        item.Question,
		ExpectedAnswer:  item.ExpectedAnswer,
	})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.Prompt, item.Explanation, item.StartSeconds, configJSON, nil
}
