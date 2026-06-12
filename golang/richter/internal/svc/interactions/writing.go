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
	registerHandler(&writingHandler{})
}

type writingConfigJSON struct {
	Prompt         string `json:"prompt"`
	Rubric         string `json:"rubric,omitempty"`
	ExpectedAnswer string `json:"expected_answer,omitempty"`
	MinWords       int32  `json:"min_words,omitempty"`
}

type writingResponseJSON struct {
	Text string `json:"text"`
}

type writingHandler struct{}

func (h *writingHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_WRITING
}

// Grade is the fallback when GradingDeps is not wired (unit tests, missing AI
// config). An essay cannot be graded without the AI, so return 0 with a pending
// message rather than awarding credit for an ungraded submission.
func (h *writingHandler) Grade(_, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var resp writingResponseJSON
	if len(responseJSON) > 0 {
		_ = json.Unmarshal(responseJSON, &resp)
	}
	if strings.TrimSpace(resp.Text) == "" {
		return 0, 1, "Chưa có bài viết.", nil
	}
	return 0, 1, "Chưa chấm điểm — hệ thống AI chưa được cấu hình.", nil
}

// GradeWithContext implements ContextualGrader — used by SubmitAttempt when the
// AI service is wired. It grades the essay against the prompt/rubric via Gemini.
func (h *writingHandler) GradeWithContext(ctx context.Context, deps GradingDeps, configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg writingConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("writing: unmarshal config: %w", err)
	}
	var resp writingResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("writing: unmarshal response: %w", err)
	}

	essay := strings.TrimSpace(resp.Text)
	if essay == "" {
		return 0, 1, "Chưa có bài viết.", nil
	}
	words := len(strings.Fields(essay))
	if cfg.MinWords > 0 && words < int(cfg.MinWords) {
		return 0, 1, fmt.Sprintf("Bài viết quá ngắn: cần ít nhất %d từ, hiện có %d.", cfg.MinWords, words), nil
	}

	if deps.GradeText == nil {
		// Symmetric with the reading handler's infra-hiccup fallback: pending
		// credit + teacher review keeps the lesson flow alive when AI is absent.
		return 0.5, 1.0, "Hệ thống AI chưa sẵn sàng để chấm. Giáo viên sẽ xem lại.", nil
	}

	// Compose the grading question from the essay prompt and the optional rubric.
	question := cfg.Prompt
	if strings.TrimSpace(cfg.Rubric) != "" {
		question = fmt.Sprintf("Đề bài: %s\n\nTiêu chí chấm điểm: %s", cfg.Prompt, cfg.Rubric)
	}

	score, maxScore, feedback, err = deps.GradeText(ctx, question, essay, cfg.ExpectedAnswer)
	if err != nil {
		// Do not 500 the whole submission for a transient AI hiccup; award pending
		// credit and flag for teacher review, mirroring the reading handler.
		return 0.5, 1.0, "Hệ thống chưa chấm được bài viết. Giáo viên sẽ xem lại.", nil
	}
	if maxScore <= 0 {
		maxScore = 1.0
	}
	return score, maxScore, feedback, nil
}

// ResponseWordCount implements TextResponseMeasurer: counts words in the essay.
func (h *writingHandler) ResponseWordCount(responseJSON []byte) (int, bool) {
	var resp writingResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, false
	}
	return len(strings.Fields(resp.Text)), true
}

func (h *writingHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	w, ok := req.Response.(*richterv1.AttemptResponseInput_Writing)
	if !ok || w == nil || w.Writing == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("writing: missing writing response"))
	}
	return json.Marshal(writingResponseJSON{Text: w.Writing.Text})
}

func (h *writingHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp writingResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		r.Response = &richterv1.LessonAttemptResponse_Writing{
			Writing: &richterv1.WritingResponse{Text: resp.Text},
		}
	}
	return r
}

func (h *writingHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg writingConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	expected := cfg.ExpectedAnswer
	if stripAnswers {
		// The model answer must never reach the student before submission.
		expected = ""
	}
	p.Config = &richterv1.LessonInteraction_Writing{
		Writing: &richterv1.WritingConfig{
			Prompt:         cfg.Prompt,
			Rubric:         cfg.Rubric,
			ExpectedAnswer: expected,
			MinWords:       cfg.MinWords,
		},
	}
	return true
}

func (h *writingHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	w, ok := req.Config.(*richterv1.CreateManualInteractionRequest_Writing)
	if !ok || w == nil || w.Writing == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("writing: missing config"))
	}
	return h.protoToJSON(w.Writing)
}

func (h *writingHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	w, ok := req.Config.(*richterv1.UpdateInteractionRequest_Writing)
	if !ok || w == nil || w.Writing == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("writing: missing config"))
	}
	return h.protoToJSON(w.Writing)
}

func (h *writingHandler) protoToJSON(cfg *richterv1.WritingConfig) ([]byte, error) {
	if strings.TrimSpace(cfg.Prompt) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("writing: prompt empty"))
	}
	if cfg.MinWords < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("writing: min_words must be >= 0"))
	}
	return json.Marshal(writingConfigJSON{
		Prompt:         cfg.Prompt,
		Rubric:         cfg.Rubric,
		ExpectedAnswer: cfg.ExpectedAnswer,
		MinWords:       cfg.MinWords,
	})
}
