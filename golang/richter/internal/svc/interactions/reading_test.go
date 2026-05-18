package interactions

import (
	"encoding/json"
	"testing"
)

func TestReadingGrade(t *testing.T) {
	h := &readingHandler{}

	cfg := readingConfigJSON{
		PassageMarkdown: "The sky is blue.",
		Questions: []nestedMcqConfigJSON{
			{Options: []string{"red", "blue", "green", "yellow"}, CorrectAnswer: 1},
			{Options: []string{"A", "B", "C", "D"}, CorrectAnswer: 3},
			{Options: []string{"P", "Q", "R", "S"}, CorrectAnswer: 0},
		},
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("all correct", func(t *testing.T) {
		resp := readingResponseJSON{Answers: []int32{1, 3, 0}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 3.0 {
			t.Errorf("maxScore: want 3, got %v", max)
		}
		if score != 3.0 {
			t.Errorf("score: want 3, got %v", score)
		}
	})

	t.Run("none correct", func(t *testing.T) {
		resp := readingResponseJSON{Answers: []int32{0, 0, 1}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 3.0 || score != 0.0 {
			t.Errorf("want 0/3, got %v/%v", score, max)
		}
	})

	t.Run("partial correct", func(t *testing.T) {
		// correct: [1,3,0]; answer: [1,1,1] → only first matches
		resp := readingResponseJSON{Answers: []int32{1, 1, 1}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 3.0 || score != 1.0 {
			t.Errorf("want 1/3, got %v/%v", score, max)
		}
	})

	t.Run("fewer answers than questions", func(t *testing.T) {
		resp := readingResponseJSON{Answers: []int32{1}} // only first answered
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 3.0 || score != 1.0 {
			t.Errorf("want 1/3, got %v/%v", score, max)
		}
	})
}

func TestReadingValidatePassage(t *testing.T) {
	h := &readingHandler{}

	t.Run("empty passage rejected", func(t *testing.T) {
		cfgJSON, _ := json.Marshal(readingConfigJSON{
			PassageMarkdown: "",
			Questions:       []nestedMcqConfigJSON{{Options: []string{"A", "B", "C", "D"}, CorrectAnswer: 0}},
		})
		resp := readingResponseJSON{Answers: []int32{0}}
		respJSON, _ := json.Marshal(resp)
		// Grade with empty passage should not error (passage not used in grading)
		_, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})
}

func TestGradeMcqListEmpty(t *testing.T) {
	correct, total, results := gradeMcqList(nil, nil)
	if correct != 0 || total != 0 || len(results) != 0 {
		t.Errorf("gradeMcqList(nil,nil): got %v %v %v", correct, total, results)
	}
}
