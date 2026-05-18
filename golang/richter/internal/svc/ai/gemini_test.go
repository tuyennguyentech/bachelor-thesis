package ai

import (
	"encoding/json"
	"strings"
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5/pgtype"
)

// configJSON serializes a ChunkInteractionConfig for use as DB JSONB in tests.
func configJSON(count int32, kindsStr []string, strategy string) []byte {
	type cfg struct {
		Count    int32    `json:"count,omitempty"`
		Kinds    []string `json:"kinds,omitempty"`
		Strategy string   `json:"strategy,omitempty"`
	}
	data, _ := json.Marshal(cfg{Count: count, Kinds: kindsStr, Strategy: strategy})
	return data
}

func emptyChunk() gen.LessonTranscriptChunk {
	var id pgtype.UUID
	_ = id.Scan("00000000-0000-0000-0000-000000000001")
	return gen.LessonTranscriptChunk{ID: id, QuestionCountConfig: 2}
}

func emptyLesson() gen.Lesson {
	return gen.Lesson{}
}

// ── resolveGenerationPlan tests ───────────────────────────────────────────────

func TestResolveGenerationPlan_DefaultIsAIChoose(t *testing.T) {
	// No config anywhere, no request overrides → server default is AI_CHOOSE with MCQ.
	plan := resolveGenerationPlan(
		emptyChunk(), emptyLesson(),
		nil, 0,
		richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED,
	)
	if !plan.useAIChoose {
		t.Fatal("expected AI_CHOOSE (default), got EVEN_DISTRIBUTION")
	}
	if plan.aiCount != defaultGenerationCount {
		t.Errorf("aiCount: want %d, got %d", defaultGenerationCount, plan.aiCount)
	}
	if len(plan.aiKinds) != 1 || plan.aiKinds[0] != richterv1.InteractionKind_INTERACTION_KIND_MCQ {
		t.Errorf("aiKinds: want [MCQ], got %v", plan.aiKinds)
	}
}

func TestResolveGenerationPlan_ExplicitAIChoose(t *testing.T) {
	plan := resolveGenerationPlan(
		emptyChunk(), emptyLesson(),
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_MCQ, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
		3,
		richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE,
	)
	if !plan.useAIChoose {
		t.Fatal("expected AI_CHOOSE, got EVEN_DISTRIBUTION")
	}
	if plan.aiCount != 3 {
		t.Errorf("aiCount: want 3, got %d", plan.aiCount)
	}
	if len(plan.aiKinds) != 2 {
		t.Errorf("aiKinds: want 2 kinds, got %d", len(plan.aiKinds))
	}
}

func TestResolveGenerationPlan_EvenDistribution(t *testing.T) {
	plan := resolveGenerationPlan(
		emptyChunk(), emptyLesson(),
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_MCQ, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
		4,
		richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION,
	)
	if plan.useAIChoose {
		t.Fatal("expected EVEN_DISTRIBUTION, got AI_CHOOSE")
	}
	total := int32(0)
	for _, kc := range plan.evenCounts {
		total += kc.count
	}
	if total != 4 {
		t.Errorf("total even count: want 4, got %d", total)
	}
	if len(plan.evenCounts) != 2 {
		t.Errorf("len(evenCounts): want 2, got %d", len(plan.evenCounts))
	}
}

func TestResolveGenerationPlan_ChunkConfigOverridesLesson(t *testing.T) {
	// Lesson default: EVEN, 2 MCQ.
	lesson := emptyLesson()
	lesson.DefaultInteractionConfig = configJSON(2, []string{"mcq"}, "even")

	// Chunk config: AI_CHOOSE, 3 items, MCQ+fill_blank.
	chunk := emptyChunk()
	chunk.InteractionConfig = configJSON(3, []string{"mcq", "fill_blank"}, "ai_choose")

	plan := resolveGenerationPlan(chunk, lesson, nil, 0, richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED)
	if !plan.useAIChoose {
		t.Fatal("chunk config should override lesson default strategy to AI_CHOOSE")
	}
	if plan.aiCount != 3 {
		t.Errorf("aiCount: want 3 (from chunk), got %d", plan.aiCount)
	}
}

func TestResolveGenerationPlan_RequestOverridesAll(t *testing.T) {
	// Chunk says EVEN, but request says AI_CHOOSE.
	chunk := emptyChunk()
	chunk.InteractionConfig = configJSON(2, []string{"mcq"}, "even")

	plan := resolveGenerationPlan(
		chunk, emptyLesson(),
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_MCQ, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
		5,
		richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE,
	)
	if !plan.useAIChoose {
		t.Fatal("request strategy should override chunk strategy")
	}
	if plan.aiCount != 5 {
		t.Errorf("aiCount: want 5 (from request), got %d", plan.aiCount)
	}
}

// ── buildAIChoosePrompt tests ─────────────────────────────────────────────────

func TestBuildAIChoosePrompt_ContainsBothSchemas(t *testing.T) {
	mcqHandler := svcinteractions.Get(richterv1.InteractionKind_INTERACTION_KIND_MCQ)
	fbHandler := svcinteractions.Get(richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK)
	if mcqHandler == nil || fbHandler == nil {
		t.Fatal("MCQ or FILL_BLANK handler not registered")
	}
	mcqGen, ok1 := mcqHandler.(svcinteractions.GeminiGenerator)
	fbGen, ok2 := fbHandler.(svcinteractions.GeminiGenerator)
	if !ok1 || !ok2 {
		t.Fatal("handlers do not implement GeminiGenerator")
	}

	specs := []aiChooseKindSpec{
		{kindStr: "mcq", generator: mcqGen},
		{kindStr: "fill_blank", generator: fbGen},
	}

	var id pgtype.UUID
	_ = id.Scan("00000000-0000-0000-0000-000000000002")
	chunk := gen.LessonTranscriptChunk{ID: id, StartSeconds: 0, EndSeconds: 120}
	prompt := buildAIChoosePrompt(chunk, "test transcript", 3, specs)

	for _, want := range []string{"mcq", "fill_blank", "kind", "items"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
	// Both schemas must appear in the prompt.
	if !strings.Contains(prompt, mcqGen.GeminiSchema()) {
		t.Error("prompt missing MCQ schema")
	}
	if !strings.Contains(prompt, fbGen.GeminiSchema()) {
		t.Error("prompt missing fill_blank schema")
	}
}

// ── geminiResponseText tests ──────────────────────────────────────────────────

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
