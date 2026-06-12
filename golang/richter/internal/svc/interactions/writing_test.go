package interactions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
)

func TestWritingGradeStub(t *testing.T) {
	t.Parallel()
	h := &writingHandler{}

	t.Run("empty essay → no credit", func(t *testing.T) {
		respJSON, _ := json.Marshal(writingResponseJSON{Text: "   "})
		score, max, _, err := h.Grade(nil, respJSON)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if score != 0.0 || max != 1.0 {
			t.Errorf("empty essay: want 0/1, got %v/%v", score, max)
		}
	})

	t.Run("non-empty essay, no AI → pending (0 credit)", func(t *testing.T) {
		respJSON, _ := json.Marshal(writingResponseJSON{Text: "An actual essay."})
		score, max, fb, err := h.Grade(nil, respJSON)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if score != 0.0 || max != 1.0 {
			t.Errorf("no-AI essay: want 0/1, got %v/%v", score, max)
		}
		if fb == "" {
			t.Error("expected a pending-grade feedback message")
		}
	})
}

func TestWritingProtoToJSON(t *testing.T) {
	t.Parallel()
	h := &writingHandler{}

	t.Run("valid", func(t *testing.T) {
		cfg := &richterv1.WritingConfig{
			Prompt:         "Discuss the impact of recursion.",
			Rubric:         "Clarity, correctness, examples.",
			ExpectedAnswer: "A model answer.",
			MinWords:       50,
		}
		b, err := h.protoToJSON(cfg)
		if err != nil {
			t.Fatal(err)
		}
		var out writingConfigJSON
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		if out.Prompt != cfg.Prompt || out.Rubric != cfg.Rubric || out.ExpectedAnswer != cfg.ExpectedAnswer || out.MinWords != 50 {
			t.Errorf("unexpected output: %+v", out)
		}
	})

	t.Run("empty prompt rejected", func(t *testing.T) {
		_, err := h.protoToJSON(&richterv1.WritingConfig{Prompt: "  "})
		if err == nil {
			t.Error("expected error for empty prompt")
		}
	})
}

func TestWritingApplyConfigStripsExpectedAnswer(t *testing.T) {
	t.Parallel()
	h := &writingHandler{}
	cfgJSON, _ := json.Marshal(writingConfigJSON{
		Prompt:         "Explain Big-O.",
		Rubric:         "Be precise.",
		ExpectedAnswer: "secret model answer",
		MinWords:       20,
	})

	t.Run("stripAnswers=true hides expected_answer but keeps prompt+rubric", func(t *testing.T) {
		p := &richterv1.LessonInteraction{}
		if ok := h.ApplyConfig(p, cfgJSON, true); !ok {
			t.Fatal("ApplyConfig returned false")
		}
		wc := p.GetWriting()
		if wc == nil {
			t.Fatal("Writing config missing")
		}
		if wc.GetExpectedAnswer() != "" {
			t.Errorf("expected_answer leaked to student: %q", wc.GetExpectedAnswer())
		}
		if wc.GetPrompt() != "Explain Big-O." || wc.GetRubric() != "Be precise." {
			t.Errorf("prompt/rubric should be preserved, got prompt=%q rubric=%q", wc.GetPrompt(), wc.GetRubric())
		}
	})

	t.Run("stripAnswers=false exposes expected_answer", func(t *testing.T) {
		p := &richterv1.LessonInteraction{}
		if ok := h.ApplyConfig(p, cfgJSON, false); !ok {
			t.Fatal("ApplyConfig returned false")
		}
		if got := p.GetWriting().GetExpectedAnswer(); got != "secret model answer" {
			t.Errorf("expected expected_answer exposed, got %q", got)
		}
	})
}

func TestWritingGradeWithContext(t *testing.T) {
	t.Parallel()
	h := &writingHandler{}
	cfgJSON, _ := json.Marshal(writingConfigJSON{
		Prompt:         "Explain recursion.",
		Rubric:         "Clarity and correctness.",
		ExpectedAnswer: "model",
		MinWords:       5,
	})

	t.Run("too short → 0 without calling AI", func(t *testing.T) {
		respJSON, _ := json.Marshal(writingResponseJSON{Text: "one two three"}) // 3 < 5
		deps := GradingDeps{GradeText: func(ctx context.Context, q, a, e string) (float32, float32, string, error) {
			t.Fatal("GradeText should not be called when essay is too short")
			return 0, 0, "", nil
		}}
		score, max, fb, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if score != 0 || max != 1 || !strings.Contains(fb, "quá ngắn") {
			t.Errorf("too-short: want 0/1 with 'quá ngắn' feedback, got %v/%v %q", score, max, fb)
		}
	})

	t.Run("AI grades a long-enough essay", func(t *testing.T) {
		respJSON, _ := json.Marshal(writingResponseJSON{Text: "recursion is a function that calls itself"}) // 7 words
		var gotQuestion, gotAnswer, gotExpected string
		deps := GradingDeps{GradeText: func(ctx context.Context, q, a, e string) (float32, float32, string, error) {
			gotQuestion, gotAnswer, gotExpected = q, a, e
			return 0.8, 1.0, "Tốt.", nil
		}}
		score, max, fb, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if score != 0.8 || max != 1.0 || fb != "Tốt." {
			t.Errorf("AI grade: want 0.8/1.0 'Tốt.', got %v/%v %q", score, max, fb)
		}
		if !strings.Contains(gotQuestion, "Explain recursion.") || !strings.Contains(gotQuestion, "Clarity and correctness.") {
			t.Errorf("question should include prompt + rubric, got %q", gotQuestion)
		}
		if gotAnswer != "recursion is a function that calls itself" {
			t.Errorf("answer passed to AI mismatch: %q", gotAnswer)
		}
		if gotExpected != "model" {
			t.Errorf("expected_answer should be passed to AI, got %q", gotExpected)
		}
	})

	t.Run("AI error → graceful pending credit", func(t *testing.T) {
		respJSON, _ := json.Marshal(writingResponseJSON{Text: "a reasonably long enough essay here"}) // 6 words
		deps := GradingDeps{GradeText: func(ctx context.Context, q, a, e string) (float32, float32, string, error) {
			return 0, 0, "", errors.New("simulated gemini outage")
		}}
		score, max, fb, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
		if err != nil {
			t.Fatalf("expected graceful fallback, got error: %v", err)
		}
		if score != 0.5 || max != 1.0 || fb == "" {
			t.Errorf("AI-error fallback: want 0.5/1.0 with feedback, got %v/%v %q", score, max, fb)
		}
	})
}

func TestWritingResponseWordCount(t *testing.T) {
	t.Parallel()
	h := &writingHandler{}
	respJSON, _ := json.Marshal(writingResponseJSON{Text: "one two three four"})
	n, ok := h.ResponseWordCount(respJSON)
	if !ok || n != 4 {
		t.Errorf("word count: want 4/true, got %d/%v", n, ok)
	}
}
