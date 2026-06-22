package interactions

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestListeningGrade(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}

	cfg := listeningConfigJSON{
		AudioObjectKey:  "lessons/uuid/audio.wav",
		AudioSourceText: "Câu hỏi nghe hiểu mẫu?",
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
		if max != 2.0 || score != 2.0 {
			t.Errorf("want 2/2, got %v/%v", score, max)
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

	t.Run("unanswered scores 0", func(t *testing.T) {
		resp := listeningResponseJSON{ComprehensionAnswers: []int32{-1, -1}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 2.0 || score != 0.0 {
			t.Errorf("want 0/2, got %v/%v", score, max)
		}
	})
}

// TestListeningParseGeminiItem_SingleMcq pins the single-MCQ listening model: the
// generated "question" becomes the spoken audio (audio_source_text), and the
// stored comprehension question is ONE entry with an EMPTY question text (the
// audio IS the question) plus the 4 options + correct_answer. Degenerate items
// (empty/too-short question, wrong option count, out-of-range answer) are rejected
// so the generation retry loop re-requests a clean one.
func TestListeningParseGeminiItem_SingleMcq(t *testing.T) {
	t.Parallel()
	h := &listeningHandler{}

	t.Run("rejects empty question", func(t *testing.T) {
		raw := json.RawMessage(`{
			"start_seconds": 1.0,
			"question": "   ",
			"options": ["A","B","C","D"],
			"correct_answer": 0
		}`)
		if _, _, _, _, err := h.ParseGeminiItem(raw); err == nil {
			t.Fatal("expected error for empty question")
		} else if !strings.Contains(err.Error(), "question empty") {
			t.Errorf("expected 'question empty' error, got: %v", err)
		}
	})

	t.Run("rejects too-short question", func(t *testing.T) {
		raw := json.RawMessage(`{
			"start_seconds": 1.0,
			"question": "Sao?",
			"options": ["A","B","C","D"],
			"correct_answer": 0
		}`)
		if _, _, _, _, err := h.ParseGeminiItem(raw); err == nil {
			t.Fatal("expected error for too-short question")
		} else if !strings.Contains(err.Error(), "too short") {
			t.Errorf("expected 'too short' error, got: %v", err)
		}
	})

	t.Run("rejects wrong option count", func(t *testing.T) {
		raw := json.RawMessage(`{
			"start_seconds": 1.0,
			"question": "Mục đích chính của thuật toán này là gì?",
			"options": ["A","B","C"],
			"correct_answer": 0
		}`)
		if _, _, _, _, err := h.ParseGeminiItem(raw); err == nil {
			t.Fatal("expected error for != 4 options")
		} else if !strings.Contains(err.Error(), "4 options") {
			t.Errorf("expected '4 options' error, got: %v", err)
		}
	})

	t.Run("rejects out-of-range correct_answer", func(t *testing.T) {
		raw := json.RawMessage(`{
			"start_seconds": 1.0,
			"question": "Mục đích chính của thuật toán này là gì?",
			"options": ["A","B","C","D"],
			"correct_answer": 7
		}`)
		if _, _, _, _, err := h.ParseGeminiItem(raw); err == nil {
			t.Fatal("expected error for out-of-range correct_answer")
		} else if !strings.Contains(err.Error(), "out of range") {
			t.Errorf("expected 'out of range' error, got: %v", err)
		}
	})

	t.Run("accepts a valid single MCQ — question becomes the audio", func(t *testing.T) {
		raw := json.RawMessage(`{
			"explanation": "Giải thích.",
			"start_seconds": 2.0,
			"question": "Theo đoạn giảng, mục đích chính của thuật toán đệ quy là gì?",
			"options": ["Chia bài toán thành bài toán con nhỏ hơn", "Tăng dung lượng bộ nhớ", "Xoá dữ liệu đầu vào", "Khởi động lại máy"],
			"correct_answer": 0
		}`)
		prompt, explanation, startSecs, configJSON, err := h.ParseGeminiItem(raw)
		if err != nil {
			t.Fatalf("expected valid item, got error: %v", err)
		}
		if prompt != listeningQuestionPrompt {
			t.Errorf("prompt = %q, want the fixed listening prompt %q", prompt, listeningQuestionPrompt)
		}
		if explanation != "Giải thích." || startSecs != 2.0 {
			t.Errorf("unexpected explanation=%q start=%v", explanation, startSecs)
		}
		var cfg listeningConfigJSON
		if uerr := json.Unmarshal(configJSON, &cfg); uerr != nil {
			t.Fatalf("unmarshal config: %v", uerr)
		}
		// The QUESTION is the audio source (TTS'd by AISvc later).
		if !strings.Contains(cfg.AudioSourceText, "thuật toán đệ quy") {
			t.Errorf("audio_source_text should be the question, got: %q", cfg.AudioSourceText)
		}
		if len(cfg.ComprehensionQuestions) != 1 {
			t.Fatalf("want exactly 1 comprehension question, got %d", len(cfg.ComprehensionQuestions))
		}
		q := cfg.ComprehensionQuestions[0]
		// Question text is EMPTY so the student view shows audio + options only.
		if q.Question != "" {
			t.Errorf("stored question text should be empty (audio is the question), got: %q", q.Question)
		}
		if len(q.Options) != 4 || q.CorrectAnswer != 0 {
			t.Errorf("unexpected options/correct_answer: %v / %d", q.Options, q.CorrectAnswer)
		}
	})
}
