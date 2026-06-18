package interactions

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestFillBlankGradeStatic(t *testing.T) {
	t.Parallel()
	h := &fillBlankHandler{}

	cfg := fillBlankConfigJSON{
		Template: "Cộng hòa xã hội chủ nghĩa {{0}}",
		Blanks: []blankJSON{
			{Accepted: []string{"Việt Nam"}, CaseSensitive: false},
		},
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("static exact match", func(t *testing.T) {
		resp := fillBlankResponseJSON{Answers: []string{"Việt Nam"}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 1.0 {
			t.Errorf("expected 1.0/1.0, got %v/%v", score, max)
		}
	})

	t.Run("static case insensitive match", func(t *testing.T) {
		resp := fillBlankResponseJSON{Answers: []string{"việt nam"}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 1.0 {
			t.Errorf("expected 1.0, got %v", score)
		}
	})

	t.Run("static wrong answer", func(t *testing.T) {
		resp := fillBlankResponseJSON{Answers: []string{"Lào"}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("expected 0.0, got %v", score)
		}
	})

	// Regression: a CASE-SENSITIVE accepted answer authored with stray
	// surrounding whitespace must still match the (trimmed) user input — the
	// case-sensitive branch used to compare against the untrimmed `want`.
	t.Run("case sensitive accepted answer with trailing space still matches", func(t *testing.T) {
		csCfg := fillBlankConfigJSON{
			Template: "{{0}}",
			Blanks:   []blankJSON{{Accepted: []string{"Paris "}, CaseSensitive: true}},
		}
		csJSON, _ := json.Marshal(csCfg)
		resp := fillBlankResponseJSON{Answers: []string{"Paris"}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(csJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 1.0 {
			t.Errorf("expected 1.0 (trimmed case-sensitive match), got %v", score)
		}
	})
}

func TestFillBlankGradeWithAIContext(t *testing.T) {
	t.Parallel()
	h := &fillBlankHandler{}

	cfg := fillBlankConfigJSON{
		Template: "Con {{0}} thích ăn chuối",
		Blanks: []blankJSON{
			{Accepted: []string{"khỉ", "vượn"}, CaseSensitive: false},
		},
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("AI grades synonym correctly", func(t *testing.T) {
		// Học sinh điền "hầu" (từ đồng nghĩa với khỉ)
		resp := fillBlankResponseJSON{Answers: []string{"hầu"}}
		respJSON, _ := json.Marshal(resp)

		deps := GradingDeps{
			Language: "vi",
			GradeText: func(ctx context.Context, question, studentAnswer, expectedAnswer string) (float32, float32, string, error) {
				if studentAnswer == "hầu" && strings.Contains(expectedAnswer, "khỉ") {
					return 0.9, 1.0, "Từ đồng nghĩa chính xác.", nil
				}
				return 0.0, 1.0, "Sai.", nil
			},
		}

		score, max, feedback, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 {
			t.Errorf("expected max 1.0, got %v", max)
		}
		if math.Abs(float64(score-1.0)) > 0.01 {
			t.Errorf("expected score 1.0 due to AI synonym matching, got %v", score)
		}
		if !strings.Contains(feedback, "chấm bằng AI") {
			t.Errorf("expected feedback to mention AI grading, got: %q", feedback)
		}
	})

	t.Run("AI grades wrong answer", func(t *testing.T) {
		resp := fillBlankResponseJSON{Answers: []string{"chó"}}
		respJSON, _ := json.Marshal(resp)

		deps := GradingDeps{
			Language: "vi",
			GradeText: func(ctx context.Context, question, studentAnswer, expectedAnswer string) (float32, float32, string, error) {
				return 0.1, 1.0, "Không khớp nghĩa.", nil
			},
		}

		score, max, _, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("expected score 0.0, got %v", score)
		}
		if max != 1.0 {
			t.Errorf("expected max 1.0, got %v", max)
		}
	})
}
