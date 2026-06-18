package interactions

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestListeningGradeDictation(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}

	cfg := listeningConfigJSON{
		AudioObjectKey: "lessons/uuid/audio.mp3",
		Mode:           "dictation",
		ExpectedText:   "The quick brown fox jumps over the lazy dog",
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("exact match", func(t *testing.T) {
		resp := listeningResponseJSON{Transcription: "The quick brown fox jumps over the lazy dog"}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 {
			t.Errorf("maxScore: want 1.0, got %v", max)
		}
		if math.Abs(float64(score-1.0)) > 0.01 {
			t.Errorf("score: want ~1.0, got %v", score)
		}
	})

	t.Run("case insensitive match", func(t *testing.T) {
		resp := listeningResponseJSON{Transcription: "the quick brown fox jumps over the lazy dog"}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(float64(score-1.0)) > 0.01 {
			t.Errorf("score: want ~1.0, got %v", score)
		}
	})

	t.Run("empty transcription gives 0", func(t *testing.T) {
		resp := listeningResponseJSON{Transcription: ""}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("score: want 0, got %v", score)
		}
	})

	t.Run("partial overlap between 0 and 1", func(t *testing.T) {
		resp := listeningResponseJSON{Transcription: "quick brown fox"}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score <= 0 || score >= 1.0 {
			t.Errorf("score: want 0 < score < 1, got %v", score)
		}
	})
}

func TestListeningGradeComprehension(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}

	cfg := listeningConfigJSON{
		AudioObjectKey: "lessons/uuid/audio.mp3",
		Mode:           "comprehension",
		ComprehensionQuestions: []nestedMcqConfigJSON{
			{Options: []string{"A", "B", "C", "D"}, CorrectAnswer: 0},
			{Options: []string{"A", "B", "C", "D"}, CorrectAnswer: 2},
		},
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("all correct", func(t *testing.T) {
		resp := listeningResponseJSON{ComprehensionAnswers: []int32{0, 2}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 2.0 {
			t.Errorf("maxScore: want 2, got %v", max)
		}
		if score != 2.0 {
			t.Errorf("score: want 2, got %v", score)
		}
	})

	t.Run("partial correct", func(t *testing.T) {
		resp := listeningResponseJSON{ComprehensionAnswers: []int32{0, 1}} // second wrong
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 2.0 || score != 1.0 {
			t.Errorf("want 1/2, got %v/%v", score, max)
		}
	})
}

func TestListeningGradeUnknownMode(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}
	cfg := listeningConfigJSON{AudioObjectKey: "key", Mode: "unknown"}
	cfgJSON, _ := json.Marshal(cfg)
	resp := listeningResponseJSON{}
	respJSON, _ := json.Marshal(resp)
	_, _, _, err := h.Grade(cfgJSON, respJSON)
	if err == nil {
		t.Error("expected error for unknown mode, got nil")
	}
}

func TestNormalizeText(t *testing.T) {
	t.Parallel()
	cases := []struct{ input, want string }{
		{"Hello, World!", "hello world"},
		{"  multiple   spaces  ", "multiple spaces"},
		{"Café au lait", "cafe au lait"},
		{"", ""},
	}
	for _, tc := range cases {
		got := normalizeText(tc.input)
		if got != tc.want {
			t.Errorf("normalizeText(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestWordOverlapRatio(t *testing.T) {
	t.Parallel()
	if r := wordOverlapRatio("", ""); r != 1.0 {
		t.Errorf("both empty: want 1.0, got %v", r)
	}
	if r := wordOverlapRatio("abc", ""); r != 0.0 {
		t.Errorf("one empty: want 0.0, got %v", r)
	}
	if r := wordOverlapRatio("fox dog", "fox dog"); r != 1.0 {
		t.Errorf("identical: want 1.0, got %v", r)
	}
	// Jaccard({fox,dog}, {fox,cat}) = 1/3
	r := wordOverlapRatio("fox dog", "fox cat")
	if math.Abs(r-1.0/3.0) > 0.01 {
		t.Errorf("partial: want ~0.333, got %v", r)
	}
}

func TestListeningGradeDictationWithAIContext(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}
	cfg := listeningConfigJSON{
		AudioObjectKey: "lessons/uuid/audio.mp3",
		Mode:           "dictation",
		ExpectedText:   "I love learning computer science at school",
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("AI grades synonym computer vs machine correctly", func(t *testing.T) {
		// Học sinh điền "I love learning machine science at school" (thay computer = machine)
		resp := listeningResponseJSON{Transcription: "I love learning machine science at school"}
		respJSON, _ := json.Marshal(resp)

		deps := GradingDeps{
			Language: "en",
			GradeText: func(ctx context.Context, question, studentAnswer, expectedAnswer string) (float32, float32, string, error) {
				if strings.Contains(studentAnswer, "machine science") {
					return 0.85, 1.0, "Synonym matched correctly by AI.", nil
				}
				return 0.0, 1.0, "Wrong.", nil
			},
		}

		score, max, feedback, err := h.GradeWithContext(context.Background(), deps, cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 {
			t.Errorf("expected maxScore 1.0, got %v", max)
		}
		if math.Abs(float64(score-0.85)) > 0.01 {
			t.Errorf("expected score 0.85 from AI grading, got %v", score)
		}
		if !strings.Contains(feedback, "chấm điểm tự động từ AI") {
			t.Errorf("expected feedback to mention AI, got: %q", feedback)
		}
	})
}

// TestListeningParseGeminiItem_LengthFloor covers the fix for short/meaningless
// listening audio: a passage below minListeningWords must be rejected (so the
// generation retry loop re-requests a fuller one), while a substantial passage
// with >= 2 questions parses cleanly.
func TestListeningParseGeminiItem_LengthFloor(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}

	longPassage := strings.Repeat("nội dung bài giảng mẫu ", 20) // ~80 words

	t.Run("rejects too-short audio_source_text", func(t *testing.T) {
		raw := json.RawMessage(`{
			"prompt": "Nghe và trả lời.",
			"start_seconds": 1.0,
			"audio_source_text": "Đoạn nghe rất ngắn vô nghĩa.",
			"questions": [
				{"question": "Câu hỏi một?", "options": ["A","B","C","D"], "correct_answer": 0},
				{"question": "Câu hỏi hai?", "options": ["A","B","C","D"], "correct_answer": 1}
			]
		}`)
		if _, _, _, _, err := h.ParseGeminiItem(raw); err == nil {
			t.Fatal("expected error for too-short audio_source_text")
		} else if !strings.Contains(err.Error(), "too short") {
			t.Errorf("expected 'too short' error, got: %v", err)
		}
	})

	t.Run("accepts a substantial passage with >=2 questions", func(t *testing.T) {
		raw := json.RawMessage(`{
			"prompt": "Nghe đoạn giảng và trả lời.",
			"explanation": "Giải thích.",
			"start_seconds": 2.0,
			"audio_source_text": "` + strings.TrimSpace(longPassage) + `",
			"questions": [
				{"question": "Ý chính của đoạn là gì?", "options": ["A","B","C","D"], "correct_answer": 0},
				{"question": "Chi tiết nào được nêu?", "options": ["A","B","C","D"], "correct_answer": 2}
			]
		}`)
		prompt, _, startSecs, configJSON, err := h.ParseGeminiItem(raw)
		if err != nil {
			t.Fatalf("expected valid item, got error: %v", err)
		}
		if prompt == "" || startSecs != 2.0 || len(configJSON) == 0 {
			t.Errorf("unexpected parse result: prompt=%q start=%v cfgLen=%d", prompt, startSecs, len(configJSON))
		}
	})
}
