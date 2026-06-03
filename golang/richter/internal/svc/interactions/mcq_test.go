package interactions

import (
	"encoding/json"
	"testing"
)

func TestSingleChoiceGrade(t *testing.T) {
	h := &singleChoiceHandler{}

	// Thử với số lượng 3 đáp án (khác 4)
	cfg := singleChoiceConfig{
		Options:       []string{"Python", "Go", "Java"},
		CorrectAnswer: 1, // Go
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("correct selection", func(t *testing.T) {
		resp := singleChoiceResponseJSON{Selected: 1}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 1.0 {
			t.Errorf("expected 1.0/1.0, got %v/%v", score, max)
		}
	})

	t.Run("incorrect selection", func(t *testing.T) {
		resp := singleChoiceResponseJSON{Selected: 0}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 0.0 {
			t.Errorf("expected 0.0/1.0, got %v/%v", score, max)
		}
	})
}

func TestMultipleChoiceGrade(t *testing.T) {
	h := &multipleChoiceHandler{}

	// Thử với số lượng 5 đáp án và chọn 3 đáp án đúng (khác 4)
	cfg := multipleChoiceConfig{
		Options:        []string{"A", "B", "C", "D", "E"},
		CorrectAnswers: []int{0, 2, 4}, // A, C, E
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("exactly all correct selections", func(t *testing.T) {
		resp := multipleChoiceResponseJSON{SelectedIndexes: []int{0, 2, 4}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 1.0 {
			t.Errorf("expected 1.0/1.0, got %v/%v", score, max)
		}
	})

	t.Run("missing one correct selection", func(t *testing.T) {
		resp := multipleChoiceResponseJSON{SelectedIndexes: []int{0, 4}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("expected 0.0, got %v", score)
		}
	})

	t.Run("correct selections with extra incorrect selection", func(t *testing.T) {
		resp := multipleChoiceResponseJSON{SelectedIndexes: []int{0, 1, 2, 4}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("expected 0.0, got %v", score)
		}
	})
}
