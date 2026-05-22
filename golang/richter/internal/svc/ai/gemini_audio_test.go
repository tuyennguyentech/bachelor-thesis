package ai

import (
	"testing"

	"github.com/google/generative-ai-go/genai"
)

// TestAudioGradingResponseSchema is a regression guard: the previous
// implementation built the schema by json.Unmarshal-ing a JSON-Schema string
// into genai.Schema, which panicked because Schema.Type is an int enum, not a
// string. This caused every reading-audio grade request to panic mid-handler
// and surface as HTTP 502 / Code.Unavailable on the FE. Building the schema
// with typed struct literals (and verifying that the result looks sane)
// removes the entire failure mode.
func TestAudioGradingResponseSchema(t *testing.T) {
	s := audioGradingResponseSchema()
	if s == nil {
		t.Fatal("schema is nil")
	}
	if s.Type != genai.TypeObject {
		t.Errorf("root type: want TypeObject, got %v", s.Type)
	}
	required := map[string]bool{"transcript": false, "pronunciation_score": false, "feedback": false}
	for _, name := range s.Required {
		required[name] = true
	}
	for name, found := range required {
		if !found {
			t.Errorf("required field %q missing", name)
		}
	}
	if s.Properties["transcript"] == nil || s.Properties["transcript"].Type != genai.TypeString {
		t.Errorf("transcript property: want TypeString, got %+v", s.Properties["transcript"])
	}
	if s.Properties["pronunciation_score"] == nil || s.Properties["pronunciation_score"].Type != genai.TypeNumber {
		t.Errorf("pronunciation_score property: want TypeNumber, got %+v", s.Properties["pronunciation_score"])
	}
	if s.Properties["content_score"] == nil || s.Properties["content_score"].Type != genai.TypeNumber {
		t.Errorf("content_score property: want TypeNumber, got %+v", s.Properties["content_score"])
	}
	if s.Properties["feedback"] == nil || s.Properties["feedback"].Type != genai.TypeString {
		t.Errorf("feedback property: want TypeString, got %+v", s.Properties["feedback"])
	}
}
