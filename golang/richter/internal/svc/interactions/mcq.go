package interactions

import (
	"encoding/json"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
)

func init() {
	registerHandler(&mcqHandler{})
}

type mcqConfig struct {
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
}

type mcqResponseJSON struct {
	Selected int `json:"selected"`
}

type mcqHandler struct{}

func (h *mcqHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_MCQ
}

func (h *mcqHandler) Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg mcqConfig
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("mcq: unmarshal config: %w", err)
	}
	var resp mcqResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("mcq: unmarshal response: %w", err)
	}
	maxScore = 1.0
	if resp.Selected == cfg.CorrectAnswer {
		score = 1.0
	}
	return score, maxScore, "", nil
}

func (h *mcqHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	mcqResp, ok := req.Response.(*richterv1.AttemptResponseInput_McqSelected)
	if !ok || mcqResp == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("mcq: missing mcq_selected in response"))
	}
	return json.Marshal(mcqResponseJSON{Selected: int(mcqResp.McqSelected)})
}

func (h *mcqHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp mcqResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		r.Response = &richterv1.LessonAttemptResponse_McqSelected{McqSelected: int32(resp.Selected)}
	}
	return r
}

func (h *mcqHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg mcqConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	opts := make([]*richterv1.McqOption, 0, len(cfg.Options))
	for _, o := range cfg.Options {
		opts = append(opts, &richterv1.McqOption{Text: o})
	}
	correctAnswer := int32(cfg.CorrectAnswer)
	if stripAnswers {
		correctAnswer = -1
	}
	p.Config = &richterv1.LessonInteraction_Mcq{Mcq: &richterv1.McqConfig{Options: opts, CorrectAnswer: correctAnswer}}
	return true
}

func (h *mcqHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	mcqCfg, ok := req.Config.(*richterv1.CreateManualInteractionRequest_Mcq)
	if !ok || mcqCfg == nil || mcqCfg.Mcq == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("mcq: missing mcq config"))
	}
	return h.mcqProtoToJSON(mcqCfg.Mcq)
}

func (h *mcqHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	mcqCfg, ok := req.Config.(*richterv1.UpdateInteractionRequest_Mcq)
	if !ok || mcqCfg == nil || mcqCfg.Mcq == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("mcq: missing mcq config"))
	}
	return h.mcqProtoToJSON(mcqCfg.Mcq)
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

type mcqGeminiItem struct {
	QuestionText  string   `json:"question_text"`
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
	Explanation   string   `json:"explanation"`
	StartSeconds  float32  `json:"start_seconds"`
}

func (h *mcqHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["question_text","options","correct_answer","start_seconds"],
  "properties": {
    "question_text":  {"type": "string"},
    "options":        {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
    "correct_answer": {"type": "integer"},
    "explanation":    {"type": "string"},
    "start_seconds":  {"type": "number"}
  }
}`
}

func (h *mcqHandler) GeminiPromptHint() string {
	return "Tạo câu hỏi trắc nghiệm (MCQ). Mỗi câu có 4 lựa chọn (A, B, C, D), chỉ có 1 đáp án đúng."
}

func (h *mcqHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item mcqGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("mcq: parse gemini item: %w", err)
	}
	if item.CorrectAnswer < 0 || item.CorrectAnswer >= len(item.Options) {
		return "", "", 0, nil, fmt.Errorf("mcq: correct_answer %d out of range [0,%d)", item.CorrectAnswer, len(item.Options))
	}
	configJSON, err = json.Marshal(mcqConfig{Options: item.Options, CorrectAnswer: item.CorrectAnswer})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.QuestionText, item.Explanation, item.StartSeconds, configJSON, nil
}

func (h *mcqHandler) mcqProtoToJSON(mcq *richterv1.McqConfig) ([]byte, error) {
	if len(mcq.Options) < 2 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("mcq: at least 2 options required"))
	}
	if int(mcq.CorrectAnswer) < 0 || int(mcq.CorrectAnswer) >= len(mcq.Options) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("mcq: correct_answer index out of range"))
	}
	opts := make([]string, 0, len(mcq.Options))
	for _, o := range mcq.Options {
		opts = append(opts, o.Text)
	}
	return json.Marshal(mcqConfig{Options: opts, CorrectAnswer: int(mcq.CorrectAnswer)})
}
