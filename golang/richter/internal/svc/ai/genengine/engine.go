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
	"sync"

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
func NewGemini(geminiCfg *cfg.GeminiCfg) Engine {
	e := &geminiEngine{cfg: geminiCfg}
	if geminiCfg.MaxConcurrent > 0 {
		// Buffered channel as a counting semaphore: each in-flight Generate
		// takes a slot and releases on return, blocking excess callers. Caps
		// total concurrent Gemini calls across all pipelines so a burst of
		// quick-create pipelines can't collectively exhaust the per-minute
		// quota and retry-storm. Mirrors the STT semaphore.
		e.sem = make(chan struct{}, geminiCfg.MaxConcurrent)
	}
	return e
}

type geminiEngine struct {
	cfg *cfg.GeminiCfg
	sem chan struct{}

	// The genai client is safe for concurrent use and meant to be long-lived;
	// reuse one instead of dialing a fresh client (and TLS handshake) on every
	// call — which mattered under the retry-storm that motivated the cap above.
	clientOnce sync.Once
	client     *genai.Client
	clientErr  error
}

func (e *geminiEngine) Name() string { return "gemini" }

// getClient lazily builds and caches the shared genai client. Lazy (not in the
// constructor) so DI wiring never fails when the API key is absent in a config
// that won't actually call Gemini.
func (e *geminiEngine) getClient(ctx context.Context) (*genai.Client, error) {
	e.clientOnce.Do(func() {
		// Use a background context for the long-lived client, not the per-call
		// ctx (which is cancelled when the call returns).
		e.client, e.clientErr = genai.NewClient(context.WithoutCancel(ctx), option.WithAPIKey(e.cfg.APIKey))
	})
	return e.client, e.clientErr
}

// acquireSlot blocks until a concurrency slot is free (or ctx is done) and
// returns a release func. When no cap is configured it's a no-op. Extracted from
// Generate so the cap is unit-testable without a real Gemini call.
func (e *geminiEngine) acquireSlot(ctx context.Context) (func(), error) {
	if e.sem == nil {
		return func() {}, nil
	}
	select {
	case e.sem <- struct{}{}:
		return func() { <-e.sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (e *geminiEngine) Generate(ctx context.Context, req Request) (string, error) {
	if e.cfg.APIKey == "" {
		return "", fmt.Errorf("Gemini API key not configured (set RICHTER_GEMINI_API_KEY or gemini.api_key in config)")
	}

	// Acquire a concurrency slot (if a cap is configured), honouring ctx so a
	// cancelled/timed-out call doesn't block forever waiting for a slot.
	release, err := e.acquireSlot(ctx)
	if err != nil {
		return "", err
	}
	defer release()

	client, err := e.getClient(ctx)
	if err != nil {
		return "", fmt.Errorf("create gemini client: %w", err)
	}

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
