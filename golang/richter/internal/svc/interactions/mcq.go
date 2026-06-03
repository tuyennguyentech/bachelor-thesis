package interactions

import (
	"encoding/json"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
)

func init() {
	registerHandler(&singleChoiceHandler{})
	registerHandler(&multipleChoiceHandler{})
}

// ── Single Choice Handler ─────────────────────────────────────────────────────

type singleChoiceConfig struct {
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
}

type singleChoiceResponseJSON struct {
	Selected int `json:"selected"`
}

type singleChoiceHandler struct{}

func (h *singleChoiceHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE
}

func (h *singleChoiceHandler) Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg singleChoiceConfig
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("single_choice: unmarshal config: %w", err)
	}
	var resp singleChoiceResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("single_choice: unmarshal response: %w", err)
	}
	maxScore = 1.0
	if resp.Selected == cfg.CorrectAnswer {
		score = 1.0
	}
	return score, maxScore, "", nil
}

func (h *singleChoiceHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	mcqResp, ok := req.Response.(*richterv1.AttemptResponseInput_McqSelected)
	if !ok || mcqResp == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("single_choice: missing mcq_selected in response"))
	}
	return json.Marshal(singleChoiceResponseJSON{Selected: int(mcqResp.McqSelected)})
}

func (h *singleChoiceHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp singleChoiceResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		r.Response = &richterv1.LessonAttemptResponse_McqSelected{McqSelected: int32(resp.Selected)}
	}
	return r
}

func (h *singleChoiceHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg singleChoiceConfig
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

func (h *singleChoiceHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	mcqCfg, ok := req.Config.(*richterv1.CreateManualInteractionRequest_Mcq)
	if !ok || mcqCfg == nil || mcqCfg.Mcq == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("single_choice: missing mcq config"))
	}
	return h.singleChoiceProtoToJSON(mcqCfg.Mcq)
}

func (h *singleChoiceHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	mcqCfg, ok := req.Config.(*richterv1.UpdateInteractionRequest_Mcq)
	if !ok || mcqCfg == nil || mcqCfg.Mcq == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("single_choice: missing mcq config"))
	}
	return h.singleChoiceProtoToJSON(mcqCfg.Mcq)
}

func (h *singleChoiceHandler) singleChoiceProtoToJSON(mcq *richterv1.McqConfig) ([]byte, error) {
	if len(mcq.Options) < 2 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("single_choice: at least 2 options required"))
	}
	if int(mcq.CorrectAnswer) < 0 || int(mcq.CorrectAnswer) >= len(mcq.Options) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("single_choice: correct_answer index out of range"))
	}
	opts := make([]string, 0, len(mcq.Options))
	for _, o := range mcq.Options {
		opts = append(opts, o.Text)
	}
	return json.Marshal(singleChoiceConfig{Options: opts, CorrectAnswer: int(mcq.CorrectAnswer)})
}

// ── Single Choice GeminiGenerator ─────────────────────────────────────────────

type singleChoiceGeminiItem struct {
	QuestionText  string   `json:"question_text"`
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
	Explanation   string   `json:"explanation"`
	StartSeconds  float32  `json:"start_seconds"`
}

func (h *singleChoiceHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["question_text","options","correct_answer","start_seconds"],
  "properties": {
    "question_text":  {"type": "string"},
    "options":        {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 6},
    "correct_answer": {"type": "integer"},
    "explanation":    {"type": "string"},
    "start_seconds":  {"type": "number"}
  }
}`
}

func (h *singleChoiceHandler) GeminiPromptHint() string {
	return "Tạo câu hỏi trắc nghiệm một đáp án lựa chọn đúng (Single Choice). Có từ 2 đến 6 phương án đáp án tự do."
}

func (h *singleChoiceHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item singleChoiceGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("single_choice: parse gemini item: %w", err)
	}
	if item.CorrectAnswer < 0 || item.CorrectAnswer >= len(item.Options) {
		return "", "", 0, nil, fmt.Errorf("single_choice: correct_answer %d out of range [0,%d)", item.CorrectAnswer, len(item.Options))
	}
	configJSON, err = json.Marshal(singleChoiceConfig{Options: item.Options, CorrectAnswer: item.CorrectAnswer})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.QuestionText, item.Explanation, item.StartSeconds, configJSON, nil
}

// ── Multiple Choice Handler ────────────────────────────────────────────────────

type multipleChoiceConfig struct {
	Options        []string `json:"options"`
	CorrectAnswers []int    `json:"correct_answers"`
}

type multipleChoiceResponseJSON struct {
	SelectedIndexes []int `json:"selected_indexes"`
}

type multipleChoiceHandler struct{}

func (h *multipleChoiceHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE
}

func (h *multipleChoiceHandler) Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg multipleChoiceConfig
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("multiple_choice: unmarshal config: %w", err)
	}
	var resp multipleChoiceResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("multiple_choice: unmarshal response: %w", err)
	}

	maxScore = 1.0

	// Grade logic:
	// A student gets 1.0 score only if their selected indexes exactly match correct answers.
	// If any correct answer is missed, or any incorrect answer is selected, score is 0.0.
	correctSet := make(map[int]bool)
	for _, a := range cfg.CorrectAnswers {
		correctSet[a] = true
	}
	selectedSet := make(map[int]bool)
	for _, s := range resp.SelectedIndexes {
		selectedSet[s] = true
	}

	if len(correctSet) != len(selectedSet) {
		return 0, maxScore, "", nil
	}

	for a := range correctSet {
		if !selectedSet[a] {
			return 0, maxScore, "", nil
		}
	}

	return 1.0, maxScore, "", nil
}

func (h *multipleChoiceHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	mcqResp, ok := req.Response.(*richterv1.AttemptResponseInput_McqMultiple)
	if !ok || mcqResp == nil || mcqResp.McqMultiple == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("multiple_choice: missing mcq_multiple in response"))
	}
	selected := make([]int, 0, len(mcqResp.McqMultiple.SelectedIndexes))
	for _, idx := range mcqResp.McqMultiple.SelectedIndexes {
		selected = append(selected, int(idx))
	}
	return json.Marshal(multipleChoiceResponseJSON{SelectedIndexes: selected})
}

func (h *multipleChoiceHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp multipleChoiceResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		selectedIdxs := make([]int32, 0, len(resp.SelectedIndexes))
		for _, s := range resp.SelectedIndexes {
			selectedIdxs = append(selectedIdxs, int32(s))
		}
		r.Response = &richterv1.LessonAttemptResponse_McqMultiple{
			McqMultiple: &richterv1.McqMultipleResponse{SelectedIndexes: selectedIdxs},
		}
	}
	return r
}

func (h *multipleChoiceHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg multipleChoiceConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	opts := make([]*richterv1.McqOption, 0, len(cfg.Options))
	for _, o := range cfg.Options {
		opts = append(opts, &richterv1.McqOption{Text: o})
	}
	correctAnswers := make([]int32, 0, len(cfg.CorrectAnswers))
	for _, a := range cfg.CorrectAnswers {
		correctAnswers = append(correctAnswers, int32(a))
	}
	if stripAnswers {
		correctAnswers = nil
	}
	p.Config = &richterv1.LessonInteraction_Mcq{Mcq: &richterv1.McqConfig{
		Options:        opts,
		CorrectAnswer:  -1,
		CorrectAnswers: correctAnswers,
	}}
	return true
}

func (h *multipleChoiceHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	mcqCfg, ok := req.Config.(*richterv1.CreateManualInteractionRequest_Mcq)
	if !ok || mcqCfg == nil || mcqCfg.Mcq == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("multiple_choice: missing mcq config"))
	}
	return h.multipleChoiceProtoToJSON(mcqCfg.Mcq)
}

func (h *multipleChoiceHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	mcqCfg, ok := req.Config.(*richterv1.UpdateInteractionRequest_Mcq)
	if !ok || mcqCfg == nil || mcqCfg.Mcq == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("multiple_choice: missing mcq config"))
	}
	return h.multipleChoiceProtoToJSON(mcqCfg.Mcq)
}

func (h *multipleChoiceHandler) multipleChoiceProtoToJSON(mcq *richterv1.McqConfig) ([]byte, error) {
	if len(mcq.Options) < 2 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("multiple_choice: at least 2 options required"))
	}
	opts := make([]string, 0, len(mcq.Options))
	for _, o := range mcq.Options {
		opts = append(opts, o.Text)
	}
	correctAnswers := make([]int, 0, len(mcq.CorrectAnswers))
	for _, idx := range mcq.CorrectAnswers {
		if int(idx) < 0 || int(idx) >= len(mcq.Options) {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("multiple_choice: correct_answer index %d out of range", idx))
		}
		correctAnswers = append(correctAnswers, int(idx))
	}
	return json.Marshal(multipleChoiceConfig{Options: opts, CorrectAnswers: correctAnswers})
}

// ── Multiple Choice GeminiGenerator ─────────────────────────────────────────────

type multipleChoiceGeminiItem struct {
	QuestionText   string   `json:"question_text"`
	Options        []string `json:"options"`
	CorrectAnswers []int    `json:"correct_answers"`
	Explanation    string   `json:"explanation"`
	StartSeconds   float32  `json:"start_seconds"`
}

func (h *multipleChoiceHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["question_text","options","correct_answers","start_seconds"],
  "properties": {
    "question_text":   {"type": "string"},
    "options":         {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 6},
    "correct_answers": {"type": "array", "items": {"type": "integer"}, "minItems": 1},
    "explanation":     {"type": "string"},
    "start_seconds":   {"type": "number"}
  }
}`
}

func (h *multipleChoiceHandler) GeminiPromptHint() string {
	return "Tạo câu hỏi trắc nghiệm chọn nhiều đáp án đúng (Multiple Choice). Cho phép chọn từ 1 đến nhiều đáp án đúng, có từ 2 đến 6 phương án đáp án tự do."
}

func (h *multipleChoiceHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item multipleChoiceGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("multiple_choice: parse gemini item: %w", err)
	}
	if len(item.CorrectAnswers) == 0 {
		return "", "", 0, nil, fmt.Errorf("multiple_choice: at least one correct answer required")
	}
	for _, a := range item.CorrectAnswers {
		if a < 0 || a >= len(item.Options) {
			return "", "", 0, nil, fmt.Errorf("multiple_choice: correct_answer index %d out of range [0,%d)", a, len(item.Options))
		}
	}
	configJSON, err = json.Marshal(multipleChoiceConfig{Options: item.Options, CorrectAnswers: item.CorrectAnswers})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.QuestionText, item.Explanation, item.StartSeconds, configJSON, nil
}
