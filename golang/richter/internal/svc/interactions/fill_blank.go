package interactions

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
)

func init() {
	registerHandler(&fillBlankHandler{})
}

type blankJSON struct {
	Accepted      []string `json:"accepted"`
	CaseSensitive bool     `json:"case_sensitive,omitempty"`
	Hint          string   `json:"hint,omitempty"`
}

type fillBlankConfigJSON struct {
	Template string      `json:"template"`
	Blanks   []blankJSON `json:"blanks"`
}

type fillBlankResponseJSON struct {
	Answers []string `json:"answers"`
}

var placeholderRE = regexp.MustCompile(`\{\{(\d+)\}\}`)

type fillBlankHandler struct{}

func (h *fillBlankHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK
}

func (h *fillBlankHandler) Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg fillBlankConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 0, "", fmt.Errorf("fill_blank: unmarshal config: %w", err)
	}
	var resp fillBlankResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 0, "", fmt.Errorf("fill_blank: unmarshal response: %w", err)
	}
	maxScore = float32(len(cfg.Blanks))
	for i, blank := range cfg.Blanks {
		if i >= len(resp.Answers) {
			continue
		}
		got := resp.Answers[i]
		for _, want := range blank.Accepted {
			if blank.CaseSensitive {
				if got == want {
					score++
					break
				}
			} else {
				if strings.EqualFold(strings.TrimSpace(got), strings.TrimSpace(want)) {
					score++
					break
				}
			}
		}
	}
	return score, maxScore, "", nil
}

func (h *fillBlankHandler) GradeWithContext(ctx context.Context, deps GradingDeps, configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg fillBlankConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 0, "", fmt.Errorf("fill_blank: unmarshal config: %w", err)
	}
	var resp fillBlankResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 0, "", fmt.Errorf("fill_blank: unmarshal response: %w", err)
	}

	maxScore = float32(len(cfg.Blanks))
	var feedbacks []string

	for i, blank := range cfg.Blanks {
		if i >= len(resp.Answers) {
			feedbacks = append(feedbacks, fmt.Sprintf("Chỗ trống %d: Chưa trả lời.", i+1))
			continue
		}
		got := strings.TrimSpace(resp.Answers[i])
		if got == "" {
			feedbacks = append(feedbacks, fmt.Sprintf("Chỗ trống %d: Chưa trả lời.", i+1))
			continue
		}

		// 1. So khớp tĩnh trước để tối ưu hóa hiệu năng
		matched := false
		for _, want := range blank.Accepted {
			if blank.CaseSensitive {
				if got == want {
					matched = true
					break
				}
			} else {
				if strings.EqualFold(got, strings.TrimSpace(want)) {
					matched = true
					break
				}
			}
		}

		if matched {
			score++
			feedbacks = append(feedbacks, fmt.Sprintf("Chỗ trống %d: Chính xác!", i+1))
			continue
		}

		// 2. So khớp tĩnh không thành công -> Dùng LLM chấm điểm ngữ nghĩa (nếu có deps.GradeText)
		if deps.GradeText != nil {
			// Tạo ngữ cảnh trực quan cho câu chứa chỗ trống đang chấm
			// Ví dụ: thay {{0}} bằng ___, giữ nguyên {{1}}...
			contextTemplate := cfg.Template
			for j := range cfg.Blanks {
				placeholder := fmt.Sprintf("{{%d}}", j)
				if j == i {
					contextTemplate = strings.ReplaceAll(contextTemplate, placeholder, "______")
				} else {
					// Nếu học sinh đã điền các chỗ trống khác, có thể hiển thị câu trả lời của họ để làm rõ ngữ cảnh
					if j < len(resp.Answers) && strings.TrimSpace(resp.Answers[j]) != "" {
						contextTemplate = strings.ReplaceAll(contextTemplate, placeholder, "["+resp.Answers[j]+"]")
					}
				}
			}

			question := fmt.Sprintf("Điền từ vào chỗ trống trong câu: '%s'. Chỗ trống hiện tại đang được biểu thị bằng '______'.", contextTemplate)
			expectedAnswer := strings.Join(blank.Accepted, ", ")

			aiScore, _, aiFeedback, aiErr := deps.GradeText(ctx, question, got, expectedAnswer)
			if aiErr == nil && aiScore >= 0.8 {
				score++
				msg := fmt.Sprintf("Chỗ trống %d: Chính xác (chấm bằng AI: %s)", i+1, got)
				if aiFeedback != "" {
					msg += " - " + aiFeedback
				}
				feedbacks = append(feedbacks, msg)
				continue
			} else {
				msg := fmt.Sprintf("Chỗ trống %d: Không chính xác. Bạn điền: '%s'. Đáp án đúng gợi ý: '%s'.", i+1, got, blank.Accepted[0])
				if aiFeedback != "" && aiScore > 0 {
					msg += " Nhận xét: " + aiFeedback
				}
				feedbacks = append(feedbacks, msg)
				continue
			}
		}

		// Fallback nếu không có AI (unit tests)
		feedbacks = append(feedbacks, fmt.Sprintf("Chỗ trống %d: Không chính xác. Bạn điền: '%s'.", i+1, got))
	}

	feedback = strings.Join(feedbacks, "\n")
	return score, maxScore, feedback, nil
}

// ResponseWordCount implements TextResponseMeasurer: counts words across all
// fill-blank answers joined by whitespace.
func (h *fillBlankHandler) ResponseWordCount(responseJSON []byte) (int, bool) {
	var resp fillBlankResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, false
	}
	joined := strings.Join(resp.Answers, " ")
	return len(strings.Fields(joined)), true
}

func (h *fillBlankHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	fb, ok := req.Response.(*richterv1.AttemptResponseInput_FillBlank)
	if !ok || fb == nil || fb.FillBlank == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("fill_blank: missing fill_blank response"))
	}
	return json.Marshal(fillBlankResponseJSON{Answers: fb.FillBlank.Answers})
}

func (h *fillBlankHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp fillBlankResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		r.Response = &richterv1.LessonAttemptResponse_FillBlank{
			FillBlank: &richterv1.FillBlankResponse{Answers: resp.Answers},
		}
	}
	return r
}

func (h *fillBlankHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg fillBlankConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	blanks := make([]*richterv1.Blank, 0, len(cfg.Blanks))
	for _, b := range cfg.Blanks {
		accepted := b.Accepted
		if stripAnswers {
			accepted = nil
		}
		blanks = append(blanks, &richterv1.Blank{
			Accepted:      accepted,
			CaseSensitive: b.CaseSensitive,
			Hint:          b.Hint,
		})
	}
	template := cfg.Template
	if stripAnswers {
		template = cfg.Template
	}
	p.Config = &richterv1.LessonInteraction_FillBlank{
		FillBlank: &richterv1.FillBlankConfig{
			Template: template,
			Blanks:   blanks,
		},
	}
	return true
}

func (h *fillBlankHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	fb, ok := req.Config.(*richterv1.CreateManualInteractionRequest_FillBlank)
	if !ok || fb == nil || fb.FillBlank == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("fill_blank: missing config"))
	}
	return h.protoToJSON(fb.FillBlank)
}

func (h *fillBlankHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	fb, ok := req.Config.(*richterv1.UpdateInteractionRequest_FillBlank)
	if !ok || fb == nil || fb.FillBlank == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("fill_blank: missing config"))
	}
	return h.protoToJSON(fb.FillBlank)
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

type fillBlankGeminiItem struct {
	Prompt       string              `json:"prompt"`
	Explanation  string              `json:"explanation"`
	StartSeconds float32             `json:"start_seconds"`
	Config       fillBlankConfigJSON `json:"config"`
}

func (h *fillBlankHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["prompt","config","start_seconds"],
  "properties": {
    "prompt":       {"type": "string"},
    "explanation":  {"type": "string"},
    "start_seconds":{"type": "number"},
    "config": {
      "type": "object",
      "required": ["template","blanks"],
      "properties": {
        "template": {"type": "string"},
        "blanks": {
          "type": "array", "minItems": 1,
          "items": {
            "type": "object",
            "required": ["accepted"],
            "properties": {
              "accepted":       {"type": "array", "items": {"type": "string"}, "minItems": 1},
              "case_sensitive": {"type": "boolean"},
              "hint":           {"type": "string"}
            }
          }
        }
      }
    }
  }
}`
}

func (h *fillBlankHandler) GeminiPromptHint() string {
	return `Tạo câu điền khuyết (fill-blank) thực sự thử thách hiểu biết khái niệm.

NGUYÊN TẮC CHỌN TỪ CẦN ĐIỀN:
- Chọn TỪ KHÓA THEN CHỐT mang ý nghĩa khái niệm cốt lõi của đoạn giảng (thuật ngữ chuyên môn, định nghĩa, nguyên lý). KHÔNG chọn giới từ, mạo từ, liên từ, hoặc từ ngẫu nhiên.
- Câu template sau khi bỏ chỗ trống phải cung cấp đủ ngữ cảnh để người học suy luận ra câu trả lời từ hiểu biết — KHÔNG phải chỉ ghi nhớ máy móc một từ ngẫu nhiên.
- Ví dụ TỐT: "Thuật toán {{0}} sắp xếp mảng bằng cách so sánh từng cặp phần tử liền kề và hoán đổi chúng nếu sai thứ tự." (→ "bubble sort")
- Ví dụ XẤU: "Bubble sort là một {{0}} sắp xếp." (→ "thuật toán" — quá dễ, không đo hiểu biết)

ĐỊNH DẠNG:
- Template dùng {{0}}, {{1}}, ... cho chỗ trống. Tối đa 2 chỗ trống mỗi câu.
- Mỗi chỗ trống: 1–3 từ, cung cấp 1–3 cách diễn đạt tương đương trong mảng accepted (từ đồng nghĩa, viết tắt phổ biến).
- Trường hint (tuỳ chọn): gợi ý ngắn không tiết lộ đáp án (ví dụ: "2 từ", "thuật ngữ tiếng Anh").
- Mặc định case_sensitive=false.
- prompt: câu hỏi/hướng dẫn rõ ràng cho người học (ví dụ: "Điền thuật ngữ còn thiếu vào câu sau:").
- explanation: giải thích tại sao đó là đáp án đúng, liên hệ lại với khái niệm trong bài giảng.`
}

func (h *fillBlankHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item fillBlankGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("fill_blank: parse gemini item: %w", err)
	}
	if strings.TrimSpace(item.Config.Template) == "" {
		return "", "", 0, nil, fmt.Errorf("fill_blank: empty template")
	}
	matches := placeholderRE.FindAllString(item.Config.Template, -1)
	if len(matches) != len(item.Config.Blanks) {
		return "", "", 0, nil, fmt.Errorf("fill_blank: %d placeholders but %d blanks", len(matches), len(item.Config.Blanks))
	}
	configJSON, err = json.Marshal(item.Config)
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.Prompt, item.Explanation, item.StartSeconds, configJSON, nil
}

func (h *fillBlankHandler) protoToJSON(cfg *richterv1.FillBlankConfig) ([]byte, error) {
	if strings.TrimSpace(cfg.Template) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("fill_blank: template empty"))
	}
	matches := placeholderRE.FindAllString(cfg.Template, -1)
	if len(matches) != len(cfg.Blanks) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("fill_blank: template has %d placeholders but %d blanks provided", len(matches), len(cfg.Blanks)))
	}
	blanks := make([]blankJSON, 0, len(cfg.Blanks))
	for i, b := range cfg.Blanks {
		if len(b.Accepted) == 0 {
			return nil, connect.NewError(connect.CodeInvalidArgument,
				fmt.Errorf("fill_blank: blank %d has no accepted answers", i))
		}
		blanks = append(blanks, blankJSON{
			Accepted:      b.Accepted,
			CaseSensitive: b.CaseSensitive,
			Hint:          b.Hint,
		})
	}
	return json.Marshal(fillBlankConfigJSON{Template: cfg.Template, Blanks: blanks})
}
