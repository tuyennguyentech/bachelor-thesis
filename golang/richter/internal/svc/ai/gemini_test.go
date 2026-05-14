package ai

import (
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
)

// makeResp constructs a GenerateContentResponse with a single candidate.
func makeResp(finishReason genai.FinishReason, text string) *genai.GenerateContentResponse {
	cand := &genai.Candidate{
		FinishReason: finishReason,
	}
	if text != "" {
		cand.Content = &genai.Content{
			Parts: []genai.Part{genai.Text(text)},
		}
	}
	return &genai.GenerateContentResponse{
		Candidates: []*genai.Candidate{cand},
	}
}

func TestGeminiResponseText_NoCandidates(t *testing.T) {
	resp := &genai.GenerateContentResponse{}
	_, err := geminiResponseText(resp)
	if err == nil {
		t.Fatal("expected error for empty candidates, got nil")
	}
	if !strings.Contains(err.Error(), "no candidates") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestGeminiResponseText_FinishReasonStop(t *testing.T) {
	resp := makeResp(genai.FinishReasonStop, `{"key":"value"}`)
	got, err := geminiResponseText(resp)
	if err != nil {
		t.Fatalf("expected no error for FinishReasonStop, got %v", err)
	}
	if got != `{"key":"value"}` {
		t.Errorf("want %q, got %q", `{"key":"value"}`, got)
	}
}

func TestGeminiResponseText_FinishReasonUnspecified(t *testing.T) {
	// FinishReasonUnspecified (0) should be treated as OK (not an error).
	resp := makeResp(genai.FinishReasonUnspecified, `{"ok":true}`)
	got, err := geminiResponseText(resp)
	if err != nil {
		t.Fatalf("expected no error for FinishReasonUnspecified, got %v", err)
	}
	if got != `{"ok":true}` {
		t.Errorf("want %q, got %q", `{"ok":true}`, got)
	}
}

func TestGeminiResponseText_FinishReasonMaxTokens(t *testing.T) {
	resp := makeResp(genai.FinishReasonMaxTokens, `{"truncated":`)
	_, err := geminiResponseText(resp)
	if err == nil {
		t.Fatal("expected error for FinishReasonMaxTokens, got nil")
	}
	if !strings.Contains(err.Error(), "finish_reason") {
		t.Errorf("expected finish_reason in error message, got %v", err)
	}
}

func TestGeminiResponseText_FinishReasonSafety(t *testing.T) {
	resp := makeResp(genai.FinishReasonSafety, "")
	_, err := geminiResponseText(resp)
	if err == nil {
		t.Fatal("expected error for FinishReasonSafety, got nil")
	}
}

func TestGeminiResponseText_NilContent(t *testing.T) {
	resp := makeResp(genai.FinishReasonStop, "")
	// No content set — cand.Content is nil.
	_, err := geminiResponseText(resp)
	if err == nil {
		t.Fatal("expected error for nil content, got nil")
	}
	if !strings.Contains(err.Error(), "no content parts") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestGeminiResponseText_EmptyTextParts(t *testing.T) {
	resp := &genai.GenerateContentResponse{
		Candidates: []*genai.Candidate{
			{
				FinishReason: genai.FinishReasonStop,
				Content: &genai.Content{
					Parts: []genai.Part{genai.Text("   ")},
				},
			},
		},
	}
	_, err := geminiResponseText(resp)
	if err == nil {
		t.Fatal("expected error for whitespace-only content, got nil")
	}
	if !strings.Contains(err.Error(), "no text content") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestGeminiResponseText_MarkdownFenceStripped(t *testing.T) {
	resp := makeResp(genai.FinishReasonStop, "```\n{\"a\":1}\n```")
	got, err := geminiResponseText(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != `{"a":1}` {
		t.Errorf("want %q after stripping markdown fence, got %q", `{"a":1}`, got)
	}
}

func TestGeminiResponseText_MarkdownFenceJsonStripped(t *testing.T) {
	resp := makeResp(genai.FinishReasonStop, "```json\n{\"b\":2}\n```")
	got, err := geminiResponseText(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != `{"b":2}` {
		t.Errorf("want %q after stripping ```json fence, got %q", `{"b":2}`, got)
	}
}

func TestGeminiResponseText_NoMarkdownFence(t *testing.T) {
	raw := `{"chunks":[{"summary":"intro"}]}`
	resp := makeResp(genai.FinishReasonStop, raw)
	got, err := geminiResponseText(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != raw {
		t.Errorf("want %q, got %q", raw, got)
	}
}
