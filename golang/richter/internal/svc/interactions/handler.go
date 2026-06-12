package interactions

import (
	"context"

	richterv1 "example.com/buf/gen/richter/v1"
)

// GradingDeps provides AI and storage dependencies needed by handlers (e.g. reading)
// that require external services to grade their responses.
type GradingDeps struct {
	Language string
	// GradeAudio calls the AI service to grade a spoken response.
	// Returns (score, maxScore, feedback, err).
	GradeAudio func(ctx context.Context, audioBytes []byte, passageMarkdown, question, expectedAnswer string) (float32, float32, string, error)
	// GradeText calls the AI service to grade a textual response.
	// Returns (score, maxScore, feedback, err).
	GradeText func(ctx context.Context, question, studentAnswer, expectedAnswer string) (float32, float32, string, error)
	// GetAudioBytes downloads the raw audio bytes for the given S3 object key.
	GetAudioBytes func(ctx context.Context, objectKey string) ([]byte, error)
}

// ContextualGrader may be optionally implemented by a Handler that needs
// context (language, AI, storage) to grade its responses.
// SubmitAttempt checks for this interface and invokes GradeWithContext when available.
type ContextualGrader interface {
	GradeWithContext(ctx context.Context, deps GradingDeps, configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error)
}

// AudioObjectCleaner may be optionally implemented by a Handler that stores
// S3 object keys in its responseJSON (e.g. reading handler). SubmitAttempt uses
// this to delete old recordings when the student retakes a lesson.
type AudioObjectCleaner interface {
	// AudioObjectKeyFromResponse returns the S3 object key stored in responseJSON.
	// Returns "" if none or if responseJSON cannot be parsed.
	AudioObjectKeyFromResponse(responseJSON []byte) string
}

// TTSProvider may be optionally implemented by a GeminiGenerator to request
// audio synthesis during AI generation (e.g. listening handler needs TTS per item).
type TTSProvider interface {
	// AudioSourceText returns the text that should be synthesised via TTS.
	// Returns "" if no synthesis is needed for this configJSON.
	AudioSourceText(configJSON []byte) string
	// SetAudioObjectKey returns new configJSON with the synthesised audio key embedded.
	SetAudioObjectKey(configJSON []byte, key string) ([]byte, error)
}

// TextResponseMeasurer may be optionally implemented by a Handler whose
// responses contain free-text (e.g. fill_blank answers, listening transcription).
// Learning analytics uses it to compute average response length in words.
// Handlers without free-text responses (mcq, reading) do not implement it, so
// the type assertion fails and the response is skipped.
type TextResponseMeasurer interface {
	// ResponseWordCount returns the number of whitespace-separated words in the
	// free-text portion of responseJSON, and ok=true if the response contributes.
	// Returns (0, false) if responseJSON cannot be parsed or carries no text.
	ResponseWordCount(responseJSON []byte) (int, bool)
}

// Handler grades a single interaction response and converts between proto and JSONB.
// Register new interaction types by implementing this interface and calling registerHandler.
type Handler interface {
	Kind() richterv1.InteractionKind
	// Grade evaluates the student's response against the interaction's config.
	// configJSON is the JSONB stored in lesson_interactions.config.
	// responseJSON is the JSONB stored in lesson_attempt_responses.response.
	Grade(configJSON, responseJSON []byte) (score, maxScore float32, feedback string, err error)
	// ResponseProtoToJSON converts the proto AttemptResponseInput.response into JSONB for storage.
	ResponseProtoToJSON(resp *richterv1.AttemptResponseInput) ([]byte, error)
	// BuildResponseProto constructs a LessonAttemptResponse proto from stored values.
	BuildResponseProto(interactionID string, responseJSON []byte, score, maxScore float32, feedback string) *richterv1.LessonAttemptResponse
	// ApplyConfig sets the config oneof field on the LessonInteraction proto, stripping answers if requested.
	// Returns false if configJSON cannot be parsed.
	ApplyConfig(p *richterv1.LessonInteraction, configJSON []byte, stripAnswers bool) bool
	// ConfigFromCreateProto converts the CreateManualInteractionRequest config to JSONB for storage.
	ConfigFromCreateProto(req *richterv1.CreateManualInteractionRequest) (configJSON []byte, err error)
	// ConfigFromUpdateProto converts the UpdateInteractionRequest config to JSONB for storage.
	ConfigFromUpdateProto(req *richterv1.UpdateInteractionRequest) (configJSON []byte, err error)
}

var registry = map[richterv1.InteractionKind]Handler{}

func registerHandler(h Handler) {
	registry[h.Kind()] = h
}

// Get returns the handler for the given kind, or nil if not registered.
func Get(kind richterv1.InteractionKind) Handler {
	return registry[kind]
}
