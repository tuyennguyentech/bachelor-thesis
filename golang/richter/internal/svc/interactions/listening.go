package interactions

import (
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

type listeningConfigJSON struct {
	AudioObjectKey string `json:"audio_object_key"`
	// AudioSourceText is the text used for TTS synthesis (set during AI generation).
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
    "audio_source_text": {"type": "string", "minLength": 10},
    "questions": {
      "type": "array", "minItems": 1, "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["options","correct_answer"],
        "properties": {
          "options":        {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
          "correct_answer": {"type": "integer"}
        }
      }
    }
  }
}`
}

func (h *listeningHandler) GeminiPromptHint() string {
	return `Tạo bài nghe dạng comprehension (hiểu nội dung). Trả về audio_source_text (đoạn văn ngắn ~50-100 từ tóm tắt nội dung để đọc to thành audio TTS) và 2-4 câu hỏi MCQ về nội dung đó.`
}

func (h *listeningHandler) ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error) {
	var item listeningGeminiItem
	if err = json.Unmarshal(raw, &item); err != nil {
		return "", "", 0, nil, fmt.Errorf("listening: parse gemini item: %w", err)
	}
	if strings.TrimSpace(item.AudioSourceText) == "" {
		return "", "", 0, nil, fmt.Errorf("listening: audio_source_text empty")
	}
	if len(item.Questions) == 0 {
		return "", "", 0, nil, fmt.Errorf("listening: questions empty")
	}
	questions := make([]nestedMcqConfigJSON, 0, len(item.Questions))
	for i, q := range item.Questions {
		if len(q.Options) != 4 {
			return "", "", 0, nil, fmt.Errorf("listening: question %d: exactly 4 options required", i)
		}
		if q.CorrectAnswer < 0 || q.CorrectAnswer >= len(q.Options) {
			return "", "", 0, nil, fmt.Errorf("listening: question %d: correct_answer out of range", i)
		}
		questions = append(questions, nestedMcqConfigJSON{Options: q.Options, CorrectAnswer: q.CorrectAnswer})
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
