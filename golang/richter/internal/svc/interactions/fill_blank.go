package interactions

import (
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
	Prompt      string          `json:"prompt"`
	Explanation string          `json:"explanation"`
	StartSeconds float32        `json:"start_seconds"`
	Config      fillBlankConfigJSON `json:"config"`
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
	return `Tạo câu điền khuyết (fill-blank). Template dùng {{0}}, {{1}}, ... làm chỗ trống. Mỗi chỗ trống cần ít nhất 1 đáp án chấp nhận được (1-3 từ). Chọn các từ khóa quan trọng về khái niệm. Mặc định case_sensitive=false.`
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
