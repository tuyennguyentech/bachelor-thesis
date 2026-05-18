package interactions

import richterv1 "example.com/buf/gen/richter/v1"

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
