package interactions

import (
	"fmt"
	"strings"

	richterv1 "example.com/buf/gen/richter/v1"
)

// gradeMcqList grades a list of MCQ responses (by selected index) against configs.
// Returns (correctCount, totalCount, perQuestionCorrect).
func gradeMcqList(configs []*richterv1.McqConfig, answers []int32) (correct, total int, results []bool) {
	total = len(configs)
	results = make([]bool, total)
	for i, cfg := range configs {
		if i < len(answers) && int(answers[i]) == int(cfg.CorrectAnswer) {
			correct++
			results[i] = true
		}
	}
	return correct, total, results
}

// validateMcqList checks that each McqConfig has ≥2 options and a valid correct_answer.
func validateMcqList(configs []*richterv1.McqConfig) error {
	if len(configs) == 0 {
		return fmt.Errorf("nested MCQ list is empty")
	}
	for i, cfg := range configs {
		if len(cfg.Options) < 2 {
			return fmt.Errorf("nested MCQ[%d]: need at least 2 options", i)
		}
		if int(cfg.CorrectAnswer) < 0 || int(cfg.CorrectAnswer) >= len(cfg.Options) {
			return fmt.Errorf("nested MCQ[%d]: correct_answer %d out of range [0,%d)", i, cfg.CorrectAnswer, len(cfg.Options))
		}
	}
	return nil
}

// mcqConfigsToJSON converts a slice of McqConfig protos to the nested JSON representation used
// in the DB JSONB column (option text strings + correct_answer index per question).
type nestedMcqConfigJSON struct {
	Question      string   `json:"question,omitempty"`
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
}

func mcqConfigsToJSON(configs []*richterv1.McqConfig) ([]nestedMcqConfigJSON, error) {
	out := make([]nestedMcqConfigJSON, 0, len(configs))
	for i, cfg := range configs {
		if len(cfg.Options) < 2 {
			return nil, fmt.Errorf("question %d: need at least 2 options", i)
		}
		opts := make([]string, 0, len(cfg.Options))
		for _, o := range cfg.Options {
			opts = append(opts, o.Text)
		}
		out = append(out, nestedMcqConfigJSON{
			Question:      strings.TrimSpace(cfg.Question),
			Options:       opts,
			CorrectAnswer: int(cfg.CorrectAnswer),
		})
	}
	return out, nil
}

// mcqConfigsFromJSON reconstructs proto McqConfig slice from stored JSON.
func mcqConfigsFromJSON(in []nestedMcqConfigJSON, stripAnswers bool) []*richterv1.McqConfig {
	out := make([]*richterv1.McqConfig, 0, len(in))
	for _, q := range in {
		opts := make([]*richterv1.McqOption, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, &richterv1.McqOption{Text: o})
		}
		correctAnswer := int32(q.CorrectAnswer)
		if stripAnswers {
			correctAnswer = -1
		}
		out = append(out, &richterv1.McqConfig{
			Question:      q.Question,
			Options:       opts,
			CorrectAnswer: correctAnswer,
		})
	}
	return out
}
