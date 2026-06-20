package interactions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"golang.org/x/text/unicode/norm"
)

func init() {
	registerHandler(&listeningHandler{})
}

// minListeningWords is the minimum word count for a generated listening passage.
// The prompt requests 60–100 words; passages below this floor are rejected so
// the generation retry loop re-requests a fuller one (a too-short passage TTS's
// into meaningless audio with seemingly-unrelated questions).
//
// Kept low enough (a real 2–3 sentence passage is ~30+ words; a degenerate
// 1-sentence blurb is ~10–15) that it still rejects degenerate audio but no
// longer drops otherwise-valid passages that land just under the aspirational
// 60-word target — over-rejection here was the main cause of listening items
// "frequently missing", since a dropped item under AI_CHOOSE was not re-requested.
const minListeningWords = 30

// instructionalMarkers are meta/instruction phrases that must never appear in a
// listening passage (the text spoken by TTS). Their presence means Gemini leaked
// the prompt or the questions into audio_source_text instead of writing lecture
// content — which makes the audio say things like "answer the following questions".
var instructionalMarkers = []string{
	"trả lời các câu hỏi", "trả lời câu hỏi sau", "các câu hỏi sau đây",
	"hãy nghe", "nghe đoạn", "nghe bài giảng sau",
	"answer the following", "following question", "listen to the",
}

// looksInstructional reports whether s reads like task instructions rather than
// spoken lecture content.
func looksInstructional(s string) bool {
	lower := strings.ToLower(s)
	for _, m := range instructionalMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
}

type listeningConfigJSON struct {
	AudioObjectKey string `json:"audio_object_key"`
	// AudioSourceText is the passage that gets synthesised to audio during AI
	// generation. INVARIANT: the spoken audio is produced from a TTS-normalized
	// copy of this text (math/CS notation → words; see ai.normalizeForTTS), but
	// THIS field keeps the original. So it must NOT be used for grading or shown
	// as a transcript/caption — it would diverge from what the learner hears.
	// (Today it isn't: auto-gen is always comprehension mode, which grades the
	// MCQ questions, and the student view never renders this string.)
	AudioSourceText        string                `json:"audio_source_text,omitempty"`
	DurationSeconds        int32                 `json:"duration_seconds,omitempty"`
	Mode                   string                `json:"mode"`
	ExpectedText           string                `json:"expected_text,omitempty"`
	ComprehensionQuestions []nestedMcqConfigJSON `json:"comprehension_questions,omitempty"`
}

type listeningResponseJSON struct {
	Transcription        string  `json:"transcription,omitempty"`
	ComprehensionAnswers []int32 `json:"comprehension_answers,omitempty"`
}

type listeningHandler struct{}

func (h *listeningHandler) Kind() richterv1.InteractionKind {
	return richterv1.InteractionKind_INTERACTION_KIND_LISTENING
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

	switch cfg.Mode {
	case "dictation":
		maxScore = 1.0
		ratio := wordOverlapRatio(resp.Transcription, cfg.ExpectedText)
		score = float32(ratio)
	case "comprehension":
		configs := make([]*richterv1.McqConfig, 0, len(cfg.ComprehensionQuestions))
		for _, q := range cfg.ComprehensionQuestions {
			opts := make([]*richterv1.McqOption, 0, len(q.Options))
			for _, o := range q.Options {
				opts = append(opts, &richterv1.McqOption{Text: o})
			}
			configs = append(configs, &richterv1.McqConfig{
				Question:      q.Question,
				Options:       opts,
				CorrectAnswer: int32(q.CorrectAnswer),
			})
		}
		correct, total, _ := gradeMcqList(configs, resp.ComprehensionAnswers)
		score = float32(correct)
		maxScore = float32(total)
	default:
		return 0, 1, "", fmt.Errorf("listening: unknown mode %q", cfg.Mode)
	}
	return score, maxScore, "", nil
}

func (h *listeningHandler) GradeWithContext(ctx context.Context, deps GradingDeps, configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error) {
	var cfg listeningConfigJSON
	if err = json.Unmarshal(configJSON, &cfg); err != nil {
		return 0, 1, "", fmt.Errorf("listening: unmarshal config: %w", err)
	}
	var resp listeningResponseJSON
	if err = json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, 1, "", fmt.Errorf("listening: unmarshal response: %w", err)
	}

	switch cfg.Mode {
	case "dictation":
		maxScore = 1.0
		got := strings.TrimSpace(resp.Transcription)
		if got == "" {
			return 0, 1.0, "Bạn chưa điền câu trả lời nghe chính tả.", nil
		}

		// 1. So khớp tĩnh bằng word overlap ratio trước
		ratio := wordOverlapRatio(got, cfg.ExpectedText)
		if ratio >= 0.95 {
			return 1.0, 1.0, "Xuất sắc! Bạn đã nghe và viết lại rất chính xác.", nil
		}

		// 2. Nếu overlap ratio thấp, dùng LLM chấm ngữ nghĩa (nếu có deps.GradeText)
		if deps.GradeText != nil {
			question := "Nghe và ghi lại chính xác nội dung đoạn âm thanh học được (Dictation/Chính tả)."
			aiScore, _, aiFeedback, aiErr := deps.GradeText(ctx, question, got, cfg.ExpectedText)
			if aiErr == nil {
				feedback = fmt.Sprintf("Kết quả chấm điểm tự động từ AI: %.0f%% chính xác.", aiScore*100)
				if aiFeedback != "" {
					feedback += " Nhận xét: " + aiFeedback
				}
				feedback += fmt.Sprintf("\nĐáp án mẫu: \"%s\"", cfg.ExpectedText)
				return aiScore, 1.0, feedback, nil
			}
		}

		// Fallback nếu không có AI hoặc lỗi AI
		feedback = fmt.Sprintf("Độ khớp từ vựng: %.0f%%. Đáp án mẫu: \"%s\"", ratio*100, cfg.ExpectedText)
		return float32(ratio), 1.0, feedback, nil

	case "comprehension":
		configs := make([]*richterv1.McqConfig, 0, len(cfg.ComprehensionQuestions))
		for _, q := range cfg.ComprehensionQuestions {
			opts := make([]*richterv1.McqOption, 0, len(q.Options))
			for _, o := range q.Options {
				opts = append(opts, &richterv1.McqOption{Text: o})
			}
			configs = append(configs, &richterv1.McqConfig{
				Question:      q.Question,
				Options:       opts,
				CorrectAnswer: int32(q.CorrectAnswer),
			})
		}
		correct, total, _ := gradeMcqList(configs, resp.ComprehensionAnswers)
		score = float32(correct)
		maxScore = float32(total)
		feedback = fmt.Sprintf("Trả lời đúng %d/%d câu hỏi tìm hiểu nội dung.", correct, total)
		return score, maxScore, feedback, nil
	default:
		return 0, 1, "", fmt.Errorf("listening: unknown mode %q", cfg.Mode)
	}
}

// ResponseWordCount implements TextResponseMeasurer: counts words in the
// dictation transcription field.
func (h *listeningHandler) ResponseWordCount(responseJSON []byte) (int, bool) {
	var resp listeningResponseJSON
	if err := json.Unmarshal(responseJSON, &resp); err != nil {
		return 0, false
	}
	return len(strings.Fields(resp.Transcription)), true
}

func (h *listeningHandler) ResponseProtoToJSON(req *richterv1.AttemptResponseInput) ([]byte, error) {
	lr, ok := req.Response.(*richterv1.AttemptResponseInput_Listening)
	if !ok || lr == nil || lr.Listening == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: missing listening response"))
	}
	return json.Marshal(listeningResponseJSON{
		Transcription:        lr.Listening.Transcription,
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
				Transcription:        resp.Transcription,
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
		Mode:            listeningModeFromString(cfg.Mode),
	}
	if !stripAnswers {
		lc.ExpectedText = cfg.ExpectedText
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
	if lc.AudioObjectKey == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: audio_object_key required"))
	}
	cfg := listeningConfigJSON{
		AudioObjectKey:  lc.AudioObjectKey,
		DurationSeconds: lc.DurationSeconds,
		Mode:            listeningModeToString(lc.Mode),
	}
	switch lc.Mode {
	case richterv1.ListeningMode_LISTENING_MODE_DICTATION:
		if strings.TrimSpace(lc.ExpectedText) == "" {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: expected_text required for dictation mode"))
		}
		cfg.ExpectedText = lc.ExpectedText
	case richterv1.ListeningMode_LISTENING_MODE_COMPREHENSION:
		if err := validateMcqList(lc.ComprehensionQuestions); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: %w", err))
		}
		for i, q := range lc.ComprehensionQuestions {
			if strings.TrimSpace(q.Question) == "" {
				return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: question %d: question text required", i))
			}
		}
		var err error
		cfg.ComprehensionQuestions, err = mcqConfigsToJSON(lc.ComprehensionQuestions)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening: mode must be dictation or comprehension"))
	}
	return json.Marshal(cfg)
}

// ── GeminiGenerator ───────────────────────────────────────────────────────────

type listeningGeminiItem struct {
	Prompt          string                `json:"prompt"`
	Explanation     string                `json:"explanation"`
	StartSeconds    float32               `json:"start_seconds"`
	AudioSourceText string                `json:"audio_source_text,omitempty"`
	Questions       []mcqGeminiItemNested `json:"questions"`
}

type mcqGeminiItemNested struct {
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	CorrectAnswer int      `json:"correct_answer"`
}

func (h *listeningHandler) GeminiSchema() string {
	return `{
  "type": "object",
  "required": ["prompt","audio_source_text","questions","start_seconds"],
  "properties": {
    "prompt":            {"type": "string"},
    "explanation":       {"type": "string"},
    "start_seconds":     {"type": "number"},
    "audio_source_text": {"type": "string", "minLength": 150},
    "questions": {
      "type": "array", "minItems": 1, "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["question","options","correct_answer"],
        "properties": {
          "question":       {"type": "string", "minLength": 8},
          "options":        {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
          "correct_answer": {"type": "integer"}
        }
      }
    }
  }
}`
}

func (h *listeningHandler) GeminiPromptHint() string {
	return `Tạo bài nghe hiểu (listening comprehension) đòi hỏi người học xử lý và suy luận thông tin — không phải nghe lại một câu rồi chọn đáp án hiển nhiên.

QUAN TRỌNG NHẤT — audio_source_text là VĂN BẢN SẼ ĐƯỢC ĐỌC THÀNH TIẾNG (text-to-speech) cho học viên nghe. Vì vậy nó CHỈ được chứa NỘI DUNG bài giảng để nghe, viết như một người đang GIẢNG/KỂ. TUYỆT ĐỐI KHÔNG được chứa:
- Lời dẫn hay hướng dẫn làm bài (vd: "Hãy nghe đoạn sau", "Trả lời các câu hỏi sau đây", "Nghe đoạn giảng về…").
- Bản thân các câu hỏi hoặc đáp án.
- Bất kỳ chữ "câu hỏi", "đáp án", "phương án" nào.
Những thứ đó thuộc về trường "prompt" và "questions", KHÔNG thuộc audio_source_text. Nếu audio_source_text đọc lên nghe như một lời dẫn/đề bài thì là SAI.

audio_source_text (đoạn nghe — nội dung để nghe):
- BẮT BUỘC dài 60–100 từ (tối thiểu 30 từ). Đoạn quá ngắn sẽ bị loại.
- PHẢI bám sát và diễn giải lại NỘI DUNG CỤ THỂ của ĐOẠN TRANSCRIPT được cung cấp ở trên (cùng chủ đề, cùng số liệu/khái niệm) — TUYỆT ĐỐI KHÔNG bịa nội dung chung chung, không dùng lời giới thiệu khoá học sáo rỗng, không nói lan man ngoài đoạn.
- Là một đoạn GIẢNG GIẢI tự nhiên, mạch lạc, một Ý TƯỞNG HOÀN CHỈNH (không cắt ngang), tự đủ ngữ cảnh — như trích một đoạn người thầy đang nói.
- Đoạn phải chứa đủ thông tin để trả lời tất cả câu hỏi phía dưới — không phụ thuộc vào kiến thức bên ngoài.
- Viết bằng văn phong nói tự nhiên, mạch lạc (không phải danh sách bullet, không tiêu đề).
- VÌ ĐOẠN SẼ ĐƯỢC ĐỌC THÀNH TIẾNG: mọi công thức, ký hiệu, notation toán/CS PHẢI viết HOÀN TOÀN BẰNG CHỮ, KHÔNG dùng ký hiệu. Ví dụ: "O(n²)" → "ô lớn của n bình phương"; "Θ(n log n)" → "theta của n nhân lốc n"; "T(n) = aT(n/b)" → "T của n bằng a nhân T của n chia b"; "7 % 2" → "7 chia 2 lấy phần dư". TUYỆT ĐỐI không để các ký hiệu như ( ) ² ³ Θ Ω Σ = % ^ _ / × ≤ ≥ trong đoạn nghe — máy đọc không phát âm được, sẽ thành tiếng ồn vô nghĩa.

Câu hỏi (2–4 câu, phân loại theo mức độ tư duy):
- ÍT NHẤT 1 câu hỏi YÊU CẦU SUY LUẬN hoặc TỔNG HỢP: "Mục đích chính của … là gì?", "Tại sao tác giả nói …?", "Điều gì sẽ xảy ra nếu …?"
- ÍT NHẤT 1 câu hỏi về CHI TIẾT CỤ THỂ không thể đoán nếu không nghe: con số, tên riêng, mối quan hệ nhân quả được nêu trong đoạn.
- CẤM: câu hỏi mà câu trả lời được lặp lại nguyên văn trong đoạn nghe (tránh echo). CẤM câu hỏi hiển nhiên chỉ cần đọc lướt.
- Mỗi câu hỏi: 4 lựa chọn, chỉ 1 đúng. Các đáp án sai phải hợp lý (không phải vô nghĩa).
- prompt: mô tả ngắn gọn nội dung đoạn nghe và yêu cầu người học (ví dụ: "Nghe đoạn giảng về [chủ đề] và trả lời các câu hỏi sau:").
- explanation: giải thích câu trả lời đúng và lý do các đáp án sai bị loại.`
}

func (h *listeningHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item listeningGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("listening: parse gemini item: %w", err)
	}
	if strings.TrimSpace(item.AudioSourceText) == "" {
		return "", "", 0, nil, fmt.Errorf("listening: audio_source_text empty")
	}
	// Reject too-short passages: Gemini sometimes returns a ~1-sentence blurb
	// that TTS turns into "very short meaningless audio" with questions that
	// feel unrelated. Returning an error makes the generation retry loop
	// (items.go) re-request a fuller passage. The prompt asks for 60–100 words;
	// 40 is a safe floor that still rejects the degenerate cases.
	if n := len(strings.Fields(item.AudioSourceText)); n < minListeningWords {
		return "", "", 0, nil, fmt.Errorf("listening: audio_source_text too short (%d words, need >= %d)", n, minListeningWords)
	}
	// Reject passages that leaked task instructions / the questions themselves into
	// the spoken content — the #1 cause of "the listening audio just says 'answer
	// the following questions'". Those belong to the prompt/questions, never to the
	// TTS-spoken passage; rejecting makes the retry loop re-request a clean one.
	if looksInstructional(item.AudioSourceText) {
		return "", "", 0, nil, fmt.Errorf("listening: audio_source_text reads like task instructions, not lecture content")
	}
	if len(item.Questions) == 0 {
		return "", "", 0, nil, fmt.Errorf("listening: questions empty")
	}
	questions := make([]nestedMcqConfigJSON, 0, len(item.Questions))
	for i, q := range item.Questions {
		question := strings.TrimSpace(q.Question)
		if question == "" {
			return "", "", 0, nil, fmt.Errorf("listening: question %d: question text empty", i)
		}
		if len(q.Options) != 4 {
			return "", "", 0, nil, fmt.Errorf("listening: question %d: exactly 4 options required", i)
		}
		if q.CorrectAnswer < 0 || q.CorrectAnswer >= len(q.Options) {
			return "", "", 0, nil, fmt.Errorf("listening: question %d: correct_answer out of range", i)
		}
		questions = append(questions, nestedMcqConfigJSON{
			Question:      question,
			Options:       q.Options,
			CorrectAnswer: q.CorrectAnswer,
		})
	}
	// audio_object_key is empty here; AISvc will call TTS + upload and set it via TTSProvider.
	configJSON, err = json.Marshal(listeningConfigJSON{
		AudioObjectKey:         "",
		AudioSourceText:        item.AudioSourceText,
		Mode:                   "comprehension",
		ComprehensionQuestions: questions,
	})
	if err != nil {
		return "", "", 0, nil, err
	}
	return item.Prompt, item.Explanation, item.StartSeconds, configJSON, nil
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

// ── helpers ───────────────────────────────────────────────────────────────────

func listeningModeToString(m richterv1.ListeningMode) string {
	switch m {
	case richterv1.ListeningMode_LISTENING_MODE_DICTATION:
		return "dictation"
	case richterv1.ListeningMode_LISTENING_MODE_COMPREHENSION:
		return "comprehension"
	default:
		return "unspecified"
	}
}

func listeningModeFromString(s string) richterv1.ListeningMode {
	switch s {
	case "dictation":
		return richterv1.ListeningMode_LISTENING_MODE_DICTATION
	case "comprehension":
		return richterv1.ListeningMode_LISTENING_MODE_COMPREHENSION
	default:
		return richterv1.ListeningMode_LISTENING_MODE_UNSPECIFIED
	}
}

// normalizeText lowercases and strips punctuation + extra whitespace for dictation grading.
func normalizeText(s string) string {
	s = norm.NFKD.String(strings.ToLower(s))
	var b strings.Builder
	prevSpace := true
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
			prevSpace = false
		} else if !prevSpace {
			b.WriteByte(' ')
			prevSpace = true
		}
	}
	return strings.TrimSpace(b.String())
}

// wordOverlapRatio returns Jaccard similarity of word sets between a and b.
func wordOverlapRatio(a, b string) float64 {
	wa := wordSet(normalizeText(a))
	wb := wordSet(normalizeText(b))
	if len(wa) == 0 && len(wb) == 0 {
		return 1.0
	}
	intersection := 0
	for w := range wa {
		if wb[w] {
			intersection++
		}
	}
	union := len(wa) + len(wb) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

func wordSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		if w != "" {
			m[w] = true
		}
	}
	return m
}
