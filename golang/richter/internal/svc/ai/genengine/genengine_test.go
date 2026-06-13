package genengine_test

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal/svc/ai/genengine"
	svcinteractions "example.com/richter/internal/svc/interactions"
)

// itemKinds are the interaction kinds the mock engine returns canned items for.
var itemKinds = []richterv1.InteractionKind{
	richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE,
	richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE,
	richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK,
	richterv1.InteractionKind_INTERACTION_KIND_READING,
	richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
}

// TestMockEngineResponsesAreSchemaValid feeds every canned mock response through
// the SAME parsers production uses (the registered generators), so the mock can
// never silently drift from the real schema. This is what lets the test suite
// trust the mock engine.
func TestMockEngineResponsesAreSchemaValid(t *testing.T) {
	genengine.MockLatency = 0 // shape-only check; skip the simulated latency
	m := genengine.NewMock()
	ctx := context.Background()

	// Chunk response parses as {"chunks":[...]} with at least one chunk.
	chunkRaw, err := m.Generate(ctx, genengine.Request{Purpose: genengine.PurposeChunk})
	if err != nil {
		t.Fatalf("mock chunk generate: %v", err)
	}
	var chunkWrap struct {
		Chunks []json.RawMessage `json:"chunks"`
	}
	if err := json.Unmarshal([]byte(chunkRaw), &chunkWrap); err != nil {
		t.Fatalf("mock chunk response is not valid JSON: %v\n%s", err, chunkRaw)
	}
	if len(chunkWrap.Chunks) == 0 {
		t.Fatalf("mock chunk response has no chunks: %s", chunkRaw)
	}

	// Each per-kind response parses through that kind's real generator.
	for _, kind := range itemKinds {
		dbStr := svcinteractions.KindToDBString(kind)
		gen, ok := svcinteractions.Get(kind).(svcinteractions.GeminiGenerator)
		if !ok {
			t.Fatalf("kind %v has no GeminiGenerator", kind)
		}
		raw, err := m.Generate(ctx, genengine.Request{Purpose: genengine.ItemsPurpose(dbStr)})
		if err != nil {
			t.Fatalf("mock generate for %s: %v", dbStr, err)
		}
		var wrap struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal([]byte(raw), &wrap); err != nil {
			t.Fatalf("mock %s response is not valid JSON: %v\n%s", dbStr, err, raw)
		}
		if len(wrap.Items) == 0 {
			t.Fatalf("mock %s response has no items: %s", dbStr, raw)
		}
		for i, it := range wrap.Items {
			if _, _, _, _, perr := gen.ParseGeminiItem(it); perr != nil {
				t.Errorf("mock %s item %d failed the real parser: %v\n%s", dbStr, i, perr, it)
			}
		}
	}

	// The AI-choose response must carry one parseable item of every kind, and —
	// critically — each item must carry a routable "kind" field, because the
	// AI_CHOOSE path (the DEFAULT strategy) routes by it: an item with no/unknown
	// kind is silently dropped. This guards the bug where the mock produced
	// kind-less items that AI_CHOOSE discarded entirely.
	aiRaw, err := m.Generate(ctx, genengine.Request{Purpose: genengine.PurposeItemsAIChoose})
	if err != nil {
		t.Fatalf("mock ai-choose generate: %v", err)
	}
	var aiWrap struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(aiRaw), &aiWrap); err != nil {
		t.Fatalf("mock ai-choose response is not valid JSON: %v\n%s", err, aiRaw)
	}
	if len(aiWrap.Items) != len(itemKinds) {
		t.Fatalf("mock ai-choose returned %d items, want %d (one per kind)", len(aiWrap.Items), len(itemKinds))
	}
	wantKinds := make(map[string]richterv1.InteractionKind, len(itemKinds))
	for _, k := range itemKinds {
		wantKinds[svcinteractions.KindToDBString(k)] = k
	}
	seenKinds := make(map[string]bool)
	for i, it := range aiWrap.Items {
		var kh struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(it, &kh); err != nil || kh.Kind == "" {
			t.Fatalf("ai-choose item %d has no routable \"kind\" field — AI_CHOOSE would drop it: %s", i, it)
		}
		kind, ok := wantKinds[kh.Kind]
		if !ok {
			t.Fatalf("ai-choose item %d has unknown kind %q", i, kh.Kind)
		}
		gen := svcinteractions.Get(kind).(svcinteractions.GeminiGenerator)
		if _, _, _, _, perr := gen.ParseGeminiItem(it); perr != nil {
			t.Errorf("ai-choose item %d (kind %s) failed the real parser: %v\n%s", i, kh.Kind, perr, it)
		}
		seenKinds[kh.Kind] = true
	}
	if len(seenKinds) != len(itemKinds) {
		t.Errorf("ai-choose covered %d distinct kinds, want %d", len(seenKinds), len(itemKinds))
	}
}

// TestRealGeminiIntegration exercises the REAL Gemini API once, to catch
// upstream breakage (auth, model rename, response shape) that the mock cannot.
// It is skipped unless RICHTER_GEMINI_API_KEY is set, so it never breaks a
// quota-less CI run; set the key (and optionally RICHTER_GEMINI_MODEL) to run it.
func TestRealGeminiIntegration(t *testing.T) {
	key := os.Getenv("RICHTER_GEMINI_API_KEY")
	if key == "" {
		t.Skip("RICHTER_GEMINI_API_KEY not set — skipping real Gemini integration test")
	}
	model := os.Getenv("RICHTER_GEMINI_MODEL")
	if model == "" {
		model = "gemini-3.1-flash-lite"
	}

	eng := genengine.NewGemini(&cfg.GeminiCfg{APIKey: key, Model: model})
	if eng.Name() != "gemini" {
		t.Fatalf("NewGemini().Name() = %q, want gemini", eng.Name())
	}

	raw, err := eng.Generate(context.Background(), genengine.Request{
		Prompt:          `Trả về DUY NHẤT một JSON object đúng định dạng: {"chunks":[{"summary":"giới thiệu","start_seconds":0,"end_seconds":5}]}`,
		Temperature:     0.2,
		MaxOutputTokens: 2048,
		JSONOutput:      true,
		Purpose:         genengine.PurposeChunk,
	})
	if err != nil {
		// Quota/rate-limit is an upstream condition, not a code defect — surface
		// it as a skip so a throttled run does not fail the suite.
		if isQuota(err) {
			t.Skipf("real Gemini quota/rate-limit hit, skipping: %v", err)
		}
		t.Fatalf("real Gemini call failed: %v", err)
	}
	var parsed struct {
		Chunks []json.RawMessage `json:"chunks"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("real Gemini returned unparseable JSON: %v\n%s", err, raw)
	}
	if len(parsed.Chunks) == 0 {
		t.Fatalf("real Gemini returned no chunks: %s", raw)
	}
}

func isQuota(err error) bool {
	msg := err.Error()
	for _, s := range []string{"429", "quota", "RESOURCE_EXHAUSTED", "rate limit", "503", "overloaded"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}
