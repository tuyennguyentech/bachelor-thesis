// Package genengine abstracts LLM text generation so the features that use it
// (transcript chunking, interaction-item generation) depend on an Engine
// interface instead of a concrete Gemini client. Which implementation runs is
// chosen by config — gemini.engine = "gemini" (real API) or "mock" (canned
// responses) — so the test suite runs deterministically and without spending
// Gemini quota, while production talks to the real model. The features never
// know which engine they are using.
package genengine

import (
	"context"
	"fmt"
	"strings"

	"example.com/richter/cfg"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// Purpose identifies what a call generates so a mock engine can return a
// shape-appropriate canned response. The real engine ignores it.
type Purpose string

const (
	// PurposeChunk is a transcript-chunking request.
	PurposeChunk Purpose = "chunk"
	// PurposeItemsAIChoose is an "AI chooses the mix" item-generation request
	// (the canned mock response carries one item of every supported kind).
	PurposeItemsAIChoose Purpose = "items:ai_choose"
)

// ItemsPurpose builds the per-kind item-generation purpose, e.g.
// ItemsPurpose("mcq") == "items:mcq". The string must be the kind's DB value
// (svcinteractions.KindToDBString).
func ItemsPurpose(kindDBString string) Purpose { return Purpose("items:" + kindDBString) }

// Request is a single structured-text generation.
type Request struct {
	// Prompt is the fully-rendered prompt (used by real engines).
	Prompt string
	// Temperature, MaxOutputTokens, JSONOutput configure a real model call.
	Temperature     float32
	MaxOutputTokens int32
	JSONOutput      bool
	// Purpose selects the mock engine's canned response; the real engine ignores it.
	Purpose Purpose
}

// Engine generates text from a Request. Implementations: the real Gemini engine
// and the in-process mock engine.
type Engine interface {
	Generate(ctx context.Context, req Request) (string, error)
	// Name reports the engine kind for logging ("gemini" or "mock").
	Name() string
}

// New returns the engine selected by geminiCfg.Engine: "mock" (case-insensitive)
// yields the mock engine (no network); anything else yields the real Gemini engine.
func New(geminiCfg *cfg.GeminiCfg) Engine {
	if strings.EqualFold(geminiCfg.Engine, "mock") {
		return NewMock()
	}
	return NewGemini(geminiCfg)
}

// NewGemini returns the real Gemini-backed engine. Exposed so an integration
// test can exercise the real API regardless of the configured engine.
func NewGemini(geminiCfg *cfg.GeminiCfg) Engine { return &geminiEngine{cfg: geminiCfg} }

type geminiEngine struct{ cfg *cfg.GeminiCfg }

func (e *geminiEngine) Name() string { return "gemini" }

func (e *geminiEngine) Generate(ctx context.Context, req Request) (string, error) {
	if e.cfg.APIKey == "" {
		return "", fmt.Errorf("Gemini API key not configured (set RICHTER_GEMINI_API_KEY or gemini.api_key in config)")
	}
	client, err := genai.NewClient(ctx, option.WithAPIKey(e.cfg.APIKey))
	if err != nil {
		return "", fmt.Errorf("create gemini client: %w", err)
	}
	defer client.Close()

	model := client.GenerativeModel(e.cfg.Model)
	model.SetTemperature(req.Temperature)
	if req.JSONOutput {
		model.ResponseMIMEType = "application/json"
	}
	if req.MaxOutputTokens > 0 {
		model.SetMaxOutputTokens(req.MaxOutputTokens)
	}

	resp, err := model.GenerateContent(ctx, genai.Text(req.Prompt))
	if err != nil {
		// Return the raw error (wrapped) so callers' transient-retry detection
		// can still inspect the underlying message.
		return "", fmt.Errorf("generate content: %w", err)
	}
	return responseText(resp)
}

// responseText extracts the text of a Gemini response, stripping markdown code
// fences some models add even with ResponseMIMEType=application/json.
func responseText(resp *genai.GenerateContentResponse) (string, error) {
	if len(resp.Candidates) == 0 {
		return "", fmt.Errorf("empty gemini response: no candidates")
	}
	cand := resp.Candidates[0]
	if cand.FinishReason != 0 && cand.FinishReason != genai.FinishReasonStop {
		return "", fmt.Errorf("gemini stopped unexpectedly (finish_reason=%v) — try a shorter input or increase max_output_tokens", cand.FinishReason)
	}
	if cand.Content == nil || len(cand.Content.Parts) == 0 {
		return "", fmt.Errorf("empty gemini response: no content parts")
	}
	var b strings.Builder
	for _, p := range cand.Content.Parts {
		if txt, ok := p.(genai.Text); ok {
			b.WriteString(string(txt))
		}
	}
	raw := strings.TrimSpace(b.String())
	if raw == "" {
		return "", fmt.Errorf("empty gemini response: no text content")
	}
	if strings.HasPrefix(raw, "```") {
		if after, found := strings.CutPrefix(raw, "```json"); found {
			raw = after
		} else {
			raw, _ = strings.CutPrefix(raw, "```")
		}
		if idx := strings.LastIndex(raw, "\n```"); idx != -1 {
			raw = raw[:idx]
		} else if idx := strings.LastIndex(raw, "```"); idx != -1 {
			raw = raw[:idx]
		}
		raw = strings.TrimSpace(raw)
	}
	return raw, nil
}
