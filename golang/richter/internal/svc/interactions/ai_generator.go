package interactions

import "encoding/json"

// GeminiGenerator is an optional interface for handlers that support Gemini-based generation.
// Handlers that implement this can be used in GenerateInteractionsStream.
type GeminiGenerator interface {
	// GeminiSchema returns the JSON schema string for Gemini structured output (one item).
	GeminiSchema() string
	// GeminiPromptHint returns kind-specific instructions to append to the Gemini prompt.
	GeminiPromptHint() string
	// ParseGeminiItem parses a single raw JSON item from the Gemini response array into
	// (prompt, explanation, startSecs, configJSON). Returns an error if parsing fails.
	ParseGeminiItem(raw json.RawMessage) (prompt, explanation string, startSecs float32, configJSON []byte, err error)
}
