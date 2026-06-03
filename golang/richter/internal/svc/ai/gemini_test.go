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
	if len(plan.aiKinds) != 1 || plan.aiKinds[0] != richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE {
		t.Errorf("aiKinds: want [SINGLE_CHOICE], got %v", plan.aiKinds)
	}
}

func TestResolveGenerationPlan_ExplicitAIChoose(t *testing.T) {
	plan := resolveGenerationPlan(
		emptyChunk(), emptyLesson(),
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
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
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
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
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
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

func TestBuildAIChoosePrompt_ContainsAllSupportedSchemas(t *testing.T) {
	kinds := []richterv1.InteractionKind{
		richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE,
		richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE,
		richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK,
		richterv1.InteractionKind_INTERACTION_KIND_READING,
		richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
	}
	specs := make([]aiChooseKindSpec, 0, len(kinds))
	generators := make(map[string]svcinteractions.GeminiGenerator, len(kinds))
	for _, kind := range kinds {
		handler := svcinteractions.Get(kind)
		if handler == nil {
			t.Fatalf("%v handler not registered", kind)
		}
		generator, ok := handler.(svcinteractions.GeminiGenerator)
		if !ok {
			t.Fatalf("%v handler does not implement GeminiGenerator", kind)
		}
		kindStr := svcinteractions.KindToDBString(kind)
		specs = append(specs, aiChooseKindSpec{kindStr: kindStr, generator: generator})
		generators[kindStr] = generator
	}

	var id pgtype.UUID
	_ = id.Scan("00000000-0000-0000-0000-000000000002")
	chunk := gen.LessonTranscriptChunk{ID: id, StartSeconds: 0, EndSeconds: 120}
	prompt := buildAIChoosePrompt(chunk, "test transcript", 5, specs, "", "", "vi")

	for _, want := range []string{"mcq", "multiple_choice", "fill_blank", "reading", "listening", "kind", "items"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
	for kindStr, generator := range generators {
		if !strings.Contains(prompt, generator.GeminiSchema()) {
			t.Errorf("prompt missing %s schema", kindStr)
		}
	}
	if !strings.Contains(prompt, "start_seconds PHẢI bằng thời điểm kết thúc đoạn: 120.0 giây") {
		t.Error("prompt should force generated checkpoints to the chunk end")
	}
}

func TestGeneratedInteractionCheckpointSecondsUsesChunkEnd(t *testing.T) {
	var id pgtype.UUID
	_ = id.Scan("00000000-0000-0000-0000-000000000003")

	chunk := gen.LessonTranscriptChunk{ID: id, StartSeconds: 10, EndSeconds: 63}
	if got := generatedInteractionCheckpointSeconds(chunk); got != 63 {
		t.Fatalf("checkpoint seconds: want chunk end 63, got %v", got)
	}

	chunk.EndSeconds = 0
	if got := generatedInteractionCheckpointSeconds(chunk); got != 10 {
		t.Fatalf("fallback checkpoint seconds: want chunk start 10, got %v", got)
	}

	chunk.StartSeconds = 0
	if got := generatedInteractionCheckpointSeconds(chunk); got != 0 {
		t.Fatalf("zero-boundary checkpoint seconds: want 0, got %v", got)
	}
}

func TestNormalizeGeneratedInteractionStartSecondsBackfillsLegacyAIItems(t *testing.T) {
	var chunkID pgtype.UUID
	_ = chunkID.Scan("00000000-0000-0000-0000-000000000004")
	var manualChunkID pgtype.UUID
	_ = manualChunkID.Scan("00000000-0000-0000-0000-000000000005")

	interactions := []gen.LessonInteraction{
		{ChunkID: chunkID, GeneratedBy: "ai", StartSeconds: 0},
		{ChunkID: manualChunkID, GeneratedBy: "manual", StartSeconds: 0},
		{ChunkID: chunkID, GeneratedBy: "ai", StartSeconds: 12},
	}
	chunks := []gen.LessonTranscriptChunk{
		{ID: chunkID, StartSeconds: 0, EndSeconds: 45},
		{ID: manualChunkID, StartSeconds: 0, EndSeconds: 90},
	}

	normalizeGeneratedInteractionStartSeconds(interactions, chunks)

	if interactions[0].StartSeconds != 45 {
		t.Fatalf("legacy AI interaction start: want chunk end 45, got %v", interactions[0].StartSeconds)
	}
	if interactions[1].StartSeconds != 0 {
		t.Fatalf("manual untimed interaction should stay at 0, got %v", interactions[1].StartSeconds)
	}
	if interactions[2].StartSeconds != 12 {
		t.Fatalf("AI interaction with explicit positive start should stay at 12, got %v", interactions[2].StartSeconds)
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
