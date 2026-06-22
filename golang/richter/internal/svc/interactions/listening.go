package interactions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
)

func init() {
	registerHandler(&listeningHandler{})
}

// minListeningQuestionWords is the floor for a generated listening question. The
// QUESTION text is what gets synthesised to audio (the learner hears it and picks
// an option), so a degenerate 1–2 word "question" TTS's into meaningless audio. A
// real question is ≥4 words; anything shorter is rejected so the generation retry
// loop re-requests one.
const minListeningQuestionWords = 4

// listeningQuestionPrompt is the (fixed) instruction shown above a listening item.
// The question itself lives in the AUDIO, so the on-screen prompt is generic.
const listeningQuestionPrompt = "Nghe câu hỏi và chọn đáp án đúng:"

// listeningConfigJSON is a single MCQ whose QUESTION is the spoken audio,
// synthesised from AudioSourceText. The stored per-question text stays empty (the
// audio IS the question); only the options + correct_answer are graded.
type listeningConfigJSON struct {
	AudioObjectKey string `json:"audio_object_key"`
	// AudioSourceText is the question text synthesised to audio. INVARIANT: the
	// spoken audio is produced from a TTS-normalized copy (math/CS notation → words;
	// see ai.normalizeForTTS), but THIS keeps the original — don't grade on it or
	// render it as a caption.
	AudioSourceText        string                `json:"audio_source_text,omitempty"`
	DurationSeconds        int32                 `json:"duration_seconds,omitempty"`
	ComprehensionQuestions []nestedMcqConfigJSON `json:"comprehension_questions,omitempty"`
}

type listeningResponseJSON struct {
	ComprehensionAnswers []int32 `json:"comprehension_answers,omitempty"`
}

type listeningHandler struct{}

func (h *listeningHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_LISTENING
}

// gradeAnswers scores the selected option indices against the stored MCQs.
func (h *listeningHandler) gradeAnswers(cfg listeningConfigJSON, answers []int32) (correct, total int) {
	configs := make([]*richterv1.McqConfig, 0, len(cfg.ComprehensionQuestions))
	for _, q := range cfg.ComprehensionQuestions {
		opts := make([]*richterv1.McqOption, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, &richterv1.McqOption{Text: o})
		}
		configs = append(configs, &richterv1.McqConfig{
			Options:       opts,
			CorrectAnswer: int32(q.CorrectAnswer),
		})
	}
	correct, total, _ = gradeMcqList(configs, answers)
	return correct, total
}

func (h *listeningHandler) Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg listeningConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("listening: unmarshal config: %w", err)
	}
	var resp listeningResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("listening: unmarshal response: %w", err)
	}
	correct, total := h.gradeAnswers(cfg, resp.ComprehensionAnswers)
	return float32(correct), float32(total), "", nil
}

func (h *listeningHandler) GradeWithContext(_ context.Context, _ GradingDeps, configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg listeningConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("listening: unmarshal config: %w", err)
	}
	var resp listeningResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("listening: unmarshal response: %w", err)
	}
	correct, total := h.gradeAnswers(cfg, resp.ComprehensionAnswers)
	return float32(correct), float32(total), fmt.Sprintf("Trả lời đúng %d/%d câu hỏi nghe hiểu.", correct, total), nil
}

func (h *listeningHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	lr, ok := req.Response.(*richterv1.AttemptResponseInput_Listening)
	if !ok || lr == nil || lr.Listening == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: missing listening response"))
	}
	return json.Marshal(listeningResponseJSON{
		ComprehensionAnswers: lr.Listening.ComprehensionAnswers,
	})
}

func (h *listeningHandler) BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse {
	r := &richterv1.LessonAttemptResponse{
		InteractionId: interactionID,
		Score:         score,
		MaxScore:      maxScore,
		Feedback:      feedback,
	}
	var resp listeningResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err == nil {
		r.Response = &richterv1.LessonAttemptResponse_Listening{
			Listening: &richterv1.ListeningResponse{
				ComprehensionAnswers: resp.ComprehensionAnswers,
			},
		}
	}
	return r
}

func (h *listeningHandler) ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool {
	var cfg listeningConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return false
	}
	lc := &richterv1.ListeningConfig{
		AudioObjectKey:  cfg.AudioObjectKey,
		DurationSeconds: cfg.DurationSeconds,
	}
	if !stripAnswers {
		// audio_source_text is the editable question text — surface it to the teacher
		// editor only. Students must NOT receive it (they hear the audio, not read it).
		lc.AudioSourceText = cfg.AudioSourceText
	}
	lc.ComprehensionQuestions = mcqConfigsFromJSON(cfg.ComprehensionQuestions, stripAnswers)
	p.Config = &richterv1.LessonInteraction_Listening{Listening: lc}
	return true
}

func (h *listeningHandler) ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) ([]byte, error) {
	lc, ok := req.Config.(*richterv1.CreateManualInteractionRequest_Listening)
	if !ok || lc == nil || lc.Listening == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: missing config"))
	}
	return h.protoToJSON(lc.Listening)
}

func (h *listeningHandler) ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) ([]byte, error) {
	lc, ok := req.Config.(*richterv1.UpdateInteractionRequest_Listening)
	if !ok || lc == nil || lc.Listening == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: missing config"))
	}
	return h.protoToJSON(lc.Listening)
}

func (h *listeningHandler) protoToJSON(lc *richterv1.ListeningConfig) ([]byte, error) {
	// Audio-as-question model: the QUESTION TEXT is the source of truth (the teacher
	// edits it) and the spoken audio is synthesised from it on save, so
	// audio_object_key may be empty here — AISvc fills it via the TTS synthesizer.
	question := strings.TrimSpace(lc.AudioSourceText)
	if question == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: audio_source_text (the question) required"))
	}
	if err := validateMcqList(lc.ComprehensionQuestions); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: %w", err))
	}
	mcqs, err := mcqConfigsToJSON(lc.ComprehensionQuestions)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	// The audio IS the question, so the stored per-question text stays empty — the
	// student view renders audio + options only.
	for i := range mcqs {
		mcqs[i].Question = ""
	}
	return json.Marshal(listeningConfigJSON{
		AudioObjectKey:         lc.AudioObjectKey,
		DurationSeconds:        lc.DurationSeconds,
		AudioSourceText:        question,
		ComprehensionQuestions: mcqs,
	})
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

// listeningGeminiItem is ONE listening MCQ: the question (synthesised to audio),
// its 4 options (shown as text), the correct index, and an explanation.
type listeningGeminiItem struct {
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
	Explanation   string   `json:"explanation"`
	StartSeconds  float32  `json:"start_seconds"`
}

func (h *listeningHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["question","options","correct_answer","start_seconds"],
  "properties": {
    "question":       {"type": "string", "minLength": 12},
    "options":        {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
    "correct_answer": {"type": "integer"},
    "explanation":    {"type": "string"},
    "start_seconds":  {"type": "number"}
  }
}`
}

func (h *listeningHandler) GeminiPromptHint() string {
	return `Tạo MỘT (1) câu hỏi trắc nghiệm NGHE HIỂU duy nhất từ ĐOẠN TRANSCRIPT được cung cấp ở trên. CHỈ một câu hỏi cho mỗi bài — KHÔNG tạo nhiều câu, KHÔNG kèm đoạn văn để nghe.

CÁCH HOẠT ĐỘNG: Trường "question" sẽ được ĐỌC THÀNH TIẾNG (text-to-speech) cho học viên NGHE. Học viên KHÔNG nhìn thấy chữ câu hỏi — chỉ NGHE. Sau khi nghe, học viên chọn 1 trong 4 phương án (các phương án hiển thị dạng CHỮ). Vì vậy bài tập là MỘT câu trắc nghiệm mà đề bài nằm trong âm thanh.

question (câu hỏi — sẽ được đọc thành tiếng):
- Là MỘT câu hỏi trắc nghiệm hoàn chỉnh, rõ ràng, tự đủ ngữ cảnh, bám sát NỘI DUNG CỤ THỂ của đoạn transcript (khái niệm/số liệu/quan hệ nhân quả được nêu trong đoạn) — KHÔNG bịa nội dung ngoài đoạn.
- Đòi hỏi HIỂU và SUY LUẬN, không phải nghe lại một câu rồi chọn đáp án hiển nhiên. Người không nắm nội dung không thể đoán mò.
- Độ dài vừa phải (1–2 câu), đủ để đọc thành tiếng trong vài giây.
- KHÔNG chứa lời dẫn kiểu "Hãy nghe đoạn sau", KHÔNG đọc các phương án trong câu hỏi — chỉ là bản thân câu hỏi.
- VÌ SẼ ĐƯỢC ĐỌC THÀNH TIẾNG: viết bằng văn nói tự nhiên; mọi công thức/ký hiệu toán-CS PHẢI viết HOÀN TOÀN BẰNG CHỮ. Ví dụ: "O(n²)" → "ô lớn của n bình phương"; "Θ(n log n)" → "theta của n nhân lốc n"; "7 % 2" → "7 chia 2 lấy phần dư". TUYỆT ĐỐI không để ký hiệu ( ) ² ³ Θ Ω Σ = % ^ _ / × ≤ ≥ trong câu hỏi — máy đọc không phát âm được.

options: ĐÚNG 4 phương án dạng chữ, chỉ 1 đúng. 3 phương án sai phải HỢP LÝ (gây nhiễu thật sự, không vô nghĩa), không trùng lặp nhau.
correct_answer: chỉ số (0–3) của phương án đúng trong mảng options.
explanation: giải thích vì sao đáp án đúng và vì sao các phương án còn lại bị loại, liên hệ lại nội dung đoạn.`
}

func (h *listeningHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item listeningGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("listening: parse gemini item: %w", err)
	}
	question := strings.TrimSpace(item.Question)
	if question == "" {
		return "", "", 0, nil, fmt.Errorf("listening: question empty")
	}
	if n := len(strings.Fields(question)); n < minListeningQuestionWords {
		return "", "", 0, nil, fmt.Errorf("listening: question too short (%d words, need >= %d)", n, minListeningQuestionWords)
	}
	if len(item.Options) != 4 {
		return "", "", 0, nil, fmt.Errorf("listening: exactly 4 options required, got %d", len(item.Options))
	}
	for i, o := range item.Options {
		if strings.TrimSpace(o) == "" {
			return "", "", 0, nil, fmt.Errorf("listening: option %d empty", i)
		}
	}
	if item.CorrectAnswer < 0 || item.CorrectAnswer >= len(item.Options) {
		return "", "", 0, nil, fmt.Errorf("listening: correct_answer %d out of range [0,%d)", item.CorrectAnswer, len(item.Options))
	}
	// The QUESTION is the audio. audio_source_text holds the question (AISvc TTS's it
	// + uploads + sets audio_object_key via TTSProvider). The stored comprehension
	// question keeps an EMPTY question text so the student view shows audio + options.
	configJSON, err = json.Marshal(listeningConfigJSON{
		AudioObjectKey:  "",
		AudioSourceText: question,
		ComprehensionQuestions: []nestedMcqConfigJSON{{
			Question:      "",
			Options:       item.Options,
			CorrectAnswer: item.CorrectAnswer,
		}},
	})
	if err != nil {
		return "", "", 0, nil, err
	}
	return listeningQuestionPrompt, item.Explanation, item.StartSeconds, configJSON, nil
}

// ── TTSProvider ───────────────────────────────────────────────────────────────

func (h *listeningHandler) AudioSourceText(configJSON []byte) string {
	var cfg listeningConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return ""
	}
	return cfg.AudioSourceText
}

func (h *listeningHandler) SetAudioObjectKey(configJSON []byte, key string) ([]byte, error) {
	var cfg listeningConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil, fmt.Errorf("listening TTSProvider: unmarshal config: %w", err)
	}
	cfg.AudioObjectKey = key
	return json.Marshal(cfg)
}

// AudioObjectKey returns the currently-stored audio key — used to carry it over
// when an edit leaves the question text unchanged, so we don't needlessly re-synth
// (and orphan the previous wav).
func (h *listeningHandler) AudioObjectKey(configJSON []byte) string {
	var cfg listeningConfigJSON
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return ""
	}
	return cfg.AudioObjectKey
}
