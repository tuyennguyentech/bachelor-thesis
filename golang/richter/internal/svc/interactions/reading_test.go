package interactions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
)

func TestReadingGradeStub(t *testing.T) {
	h := &readingHandler{}
	score, max, _, err := h.Grade(nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if score != 1.0 || max != 1.0 {
		t.Errorf("stub grade: want 1/1, got %v/%v", score, max)
	}
}

func TestReadingProtoToJSON(t *testing.T) {
	h := &readingHandler{}

	t.Run("pronunciation valid", func(t *testing.T) {
		cfg := &richterv1.ReadingConfig{
			Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
			PassageMarkdown: "The sky is blue.",
		}
		b, err := h.protoToJSON(cfg)
		if err != nil {
			t.Fatal(err)
		}
		var out readingConfigJSON
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		if out.Mode != "pronunciation" || out.PassageMarkdown != "The sky is blue." {
			t.Errorf("unexpected output: %+v", out)
		}
	})

	t.Run("open_answer valid", func(t *testing.T) {
		cfg := &richterv1.ReadingConfig{
			Mode:            richterv1.ReadingMode_READING_MODE_OPEN_ANSWER,
			PassageMarkdown: "Context passage here.",
			Question:        "What is the main idea?",
			ExpectedAnswer:  "The sky is blue.",
		}
		b, err := h.protoToJSON(cfg)
		if err != nil {
			t.Fatal(err)
		}
		var out readingConfigJSON
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		if out.Mode != "open_answer" || out.Question != "What is the main idea?" || out.ExpectedAnswer != "The sky is blue." {
			t.Errorf("unexpected output: %+v", out)
		}
	})

	t.Run("pronunciation drops expected_answer", func(t *testing.T) {
		// expected_answer is OPEN_ANSWER-only — pronunciation mode must not persist it.
		cfg := &richterv1.ReadingConfig{
			Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
			PassageMarkdown: "Read this aloud.",
			ExpectedAnswer:  "should not be stored",
		}
		b, err := h.protoToJSON(cfg)
		if err != nil {
			t.Fatal(err)
		}
		var out readingConfigJSON
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		if out.ExpectedAnswer != "" {
			t.Errorf("expected_answer should be dropped in pronunciation mode, got %q", out.ExpectedAnswer)
		}
	})

	t.Run("empty passage rejected", func(t *testing.T) {
		cfg := &richterv1.ReadingConfig{
			Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
			PassageMarkdown: "",
		}
		_, err := h.protoToJSON(cfg)
		if err == nil {
			t.Error("expected error for empty passage")
		}
	})

	t.Run("open_answer missing question rejected", func(t *testing.T) {
		cfg := &richterv1.ReadingConfig{
			Mode:            richterv1.ReadingMode_READING_MODE_OPEN_ANSWER,
			PassageMarkdown: "Some passage.",
			Question:        "",
		}
		_, err := h.protoToJSON(cfg)
		if err == nil {
			t.Error("expected error for missing question in open_answer")
		}
	})
}

func TestReadingApplyConfigStripsAnswerForStudent(t *testing.T) {
	h := &readingHandler{}
	cfgJSON, err := json.Marshal(readingConfigJSON{
		Mode:            "open_answer",
		PassageMarkdown: "Some passage.",
		Question:        "What is the main idea?",
		ExpectedAnswer:  "secret gold answer",
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("stripAnswers=true hides expected_answer", func(t *testing.T) {
		p := &richterv1.LessonInteraction{}
		if ok := h.ApplyConfig(p, cfgJSON, true); !ok {
			t.Fatal("ApplyConfig returned false")
		}
		rc := p.GetReading()
		if rc == nil {
			t.Fatal("Reading config missing")
		}
		if rc.GetExpectedAnswer() != "" {
			t.Errorf("expected_answer leaked to student: %q", rc.GetExpectedAnswer())
		}
	})

	t.Run("stripAnswers=false exposes expected_answer", func(t *testing.T) {
		p := &richterv1.LessonInteraction{}
		if ok := h.ApplyConfig(p, cfgJSON, false); !ok {
			t.Fatal("ApplyConfig returned false")
		}
		rc := p.GetReading()
		if rc == nil {
			t.Fatal("Reading config missing")
		}
		if rc.GetExpectedAnswer() != "secret gold answer" {
			t.Errorf("expected expected_answer to be exposed, got %q", rc.GetExpectedAnswer())
		}
	})
}

// TestReadingGradeWithContextGracefulOnDownloadFailure verifies the S3 download
// fallback path added in this round: when GetAudioBytes returns an error,
// GradeWithContext must NOT propagate that error — it should return a graceful
// pending result (score=0.5, max=1, non-empty feedback). This keeps a transient
// storage hiccup from 500-ing the whole grade request and surfacing as
// Code.Unavailable on the FE.
func TestReadingGradeWithContextGracefulOnDownloadFailure(t *testing.T) {
	h := &readingHandler{}
	cfgJSON, _ := json.Marshal(readingConfigJSON{
		Mode:            "pronunciation",
		PassageMarkdown: "Hello world.",
	})
	respJSON, _ := json.Marshal(readingResponseJSON{AudioObjectKey: "lessons/abc/student-recordings/xyz.webm"})

	deps := GradingDeps{
		Language: "en",
		GetAudioBytes: func(ctx context.Context, key string) ([]byte, error) {
			return nil, errors.New("simulated S3 outage")
		},
		// GradeAudio must NOT be reached because the download failed.
		GradeAudio: func(ctx context.Context, audioBytes []byte, passageMarkdown, question, expectedAnswer string) (float32, float32, string, error) {
			t.Fatalf("GradeAudio should not be called when audio download fails")
			return 0, 0, "", nil
		},
	}

	score, maxScore, feedback, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
	if err != nil {
		t.Fatalf("expected no error (graceful fallback), got %v", err)
	}
	if score != 0.5 || maxScore != 1.0 {
		t.Errorf("graceful fallback: want 0.5/1.0, got %v/%v", score, maxScore)
	}
	if !strings.Contains(feedback, "tải") && !strings.Contains(feedback, "ghi âm") {
		t.Errorf("fallback feedback should mention the download issue, got %q", feedback)
	}
}

func TestReadingModeConversions(t *testing.T) {
	cases := []struct {
		mode   richterv1.ReadingMode
		str    string
	}{
		{richterv1.ReadingMode_READING_MODE_PRONUNCIATION, "pronunciation"},
		{richterv1.ReadingMode_READING_MODE_OPEN_ANSWER, "open_answer"},
	}
	for _, c := range cases {
		if got := readingModeToString(c.mode); got != c.str {
			t.Errorf("toStr(%v): want %q, got %q", c.mode, c.str, got)
		}
		if got := readingModeFromString(c.str); got != c.mode {
			t.Errorf("fromStr(%q): want %v, got %v", c.str, c.mode, got)
		}
	}
}
