package generation

import (
	"encoding/json"
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/sql/gen"
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

func TestResolveGenerationPlan_EvenDistributionUnevenCount(t *testing.T) {
	t.Parallel()
	// 5 items across 2 kinds round-robins as 3 + 2 (first kind gets the remainder).
	plan := resolveGenerationPlan(
		emptyChunk(), emptyLesson(),
		[]richterv1.InteractionKind{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK},
		5,
		richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION,
	)
	if plan.useAIChoose {
		t.Fatal("expected EVEN_DISTRIBUTION")
	}
	byKind := map[richterv1.InteractionKind]int32{}
	for _, kc := range plan.evenCounts {
		byKind[kc.kind] = kc.count
	}
	if byKind[richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE] != 3 ||
		byKind[richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK] != 2 {
		t.Errorf("want SINGLE=3, FILL=2 (round-robin remainder to first); got %v", byKind)
	}
}

func TestInteractionGenerationBatchSize(t *testing.T) {
	t.Parallel()
	cases := []struct {
		kind richterv1.InteractionKind
		want int32
	}{
		{richterv1.InteractionKind_INTERACTION_KIND_LISTENING, 1},
		{richterv1.InteractionKind_INTERACTION_KIND_READING, 1},
		{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE, 4},
		{richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE, 4},
		{richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK, 4},
	}
	for _, c := range cases {
		t.Run(c.kind.String(), func(t *testing.T) {
			if got := interactionGenerationBatchSize(c.kind); got != c.want {
				t.Errorf("batch size for %s: want %d, got %d", c.kind, c.want, got)
			}
		})
	}
}
