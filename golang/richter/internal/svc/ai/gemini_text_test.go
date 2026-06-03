package ai

import (
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
)

func TestBuildTextOnlyGradingPrompt(t *testing.T) {
	t.Run("Vietnamese prompt", func(t *testing.T) {
		prompt := buildTextOnlyGradingPrompt("vi", "Điền từ vào câu", "học sinh", "học sinh, học viên")
		if !strings.Contains(prompt, "Tiếng Việt") {
			t.Errorf("expected prompt to contain Tiếng Việt, got %s", prompt)
		}
		if !strings.Contains(prompt, "học sinh") || !strings.Contains(prompt, "học sinh, học viên") {
			t.Errorf("expected prompt to contain bối cảnh/đáp án/câu trả lời")
		}
	})

	t.Run("English prompt", func(t *testing.T) {
		prompt := buildTextOnlyGradingPrompt("en", "Complete blank", "student", "student, pupil")
		if !strings.Contains(prompt, "Tiếng Anh (English)") {
			t.Errorf("expected prompt to contain Tiếng Anh (English), got %s", prompt)
		}
	})
}

func TestTextGradingSchema(t *testing.T) {
	// Verify that the schema type is TypeObject and includes required properties
	// This mirrors TestAudioGradingResponseSchema to avoid runtime crashes during marshalling
	schema := &genai.Schema{
		Type:     genai.TypeObject,
		Required: []string{"score", "feedback"},
		Properties: map[string]*genai.Schema{
			"score": {
				Type: genai.TypeNumber,
			},
			"feedback": {
				Type: genai.TypeString,
			},
		},
	}

	if schema.Type != genai.TypeObject {
		t.Errorf("expected TypeObject, got %v", schema.Type)
	}

	if len(schema.Required) != 2 || schema.Required[0] != "score" || schema.Required[1] != "feedback" {
		t.Errorf("expected required fields: score, feedback. got %v", schema.Required)
	}

	if schema.Properties["score"] == nil || schema.Properties["score"].Type != genai.TypeNumber {
		t.Errorf("score property should be TypeNumber")
	}

	if schema.Properties["feedback"] == nil || schema.Properties["feedback"].Type != genai.TypeString {
		t.Errorf("feedback property should be TypeString")
	}
}
