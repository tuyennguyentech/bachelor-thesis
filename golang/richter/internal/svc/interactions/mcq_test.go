package interactions

import (
	"encoding/json"
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
)

// tuid builds a deterministic, distinct pgtype.UUID from a single seed byte, for
// tests that only need stable, comparable interaction/chunk ids.
func tuid(n byte) pgtype.UUID {
	var b [16]byte
	b[0] = n
	return pgtype.UUID{Bytes: b, Valid: true}
}

func TestSingleChoiceGrade(t *testing.T) {
	t.Parallel()
	h := &singleChoiceHandler{}

	// Thử với số lượng 3 đáp án (khác 4)
	cfg := singleChoiceConfig{
		Options:       []string{"Python", "Go", "Java"},
		CorrectAnswer: 1, // Go
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("correct selection", func(t *testing.T) {
		resp := singleChoiceResponseJSON{Selected: 1}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 1.0 {
			t.Errorf("expected 1.0/1.0, got %v/%v", score, max)
		}
	})

	t.Run("incorrect selection", func(t *testing.T) {
		resp := singleChoiceResponseJSON{Selected: 0}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 0.0 {
			t.Errorf("expected 0.0/1.0, got %v/%v", score, max)
		}
	})
}

func TestMultipleChoiceGrade(t *testing.T) {
	t.Parallel()
	h := &multipleChoiceHandler{}

	// Thử với số lượng 5 đáp án và chọn 3 đáp án đúng (khác 4)
	cfg := multipleChoiceConfig{
		Options:        []string{"A", "B", "C", "D", "E"},
		CorrectAnswers: []int{0, 2, 4}, // A, C, E
	}
	cfgJSON, _ := json.Marshal(cfg)

	t.Run("exactly all correct selections", func(t *testing.T) {
		resp := multipleChoiceResponseJSON{SelectedIndexes: []int{0, 2, 4}}
		respJSON, _ := json.Marshal(resp)
		score, max, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if max != 1.0 || score != 1.0 {
			t.Errorf("expected 1.0/1.0, got %v/%v", score, max)
		}
	})

	t.Run("missing one correct selection", func(t *testing.T) {
		resp := multipleChoiceResponseJSON{SelectedIndexes: []int{0, 4}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("expected 0.0, got %v", score)
		}
	})

	t.Run("correct selections with extra incorrect selection", func(t *testing.T) {
		resp := multipleChoiceResponseJSON{SelectedIndexes: []int{0, 1, 2, 4}}
		respJSON, _ := json.Marshal(resp)
		score, _, _, err := h.Grade(cfgJSON, respJSON)
		if err != nil {
			t.Fatal(err)
		}
		if score != 0.0 {
			t.Errorf("expected 0.0, got %v", score)
		}
	})
}

// ── Per-question analytics builders (pure, no DB) ─────────────────────────────

func TestChunkForSeconds(t *testing.T) {
	t.Parallel()
	mk := func(id byte, start, end float64) gen.LessonTranscriptChunk {
		return gen.LessonTranscriptChunk{ID: tuid(id), StartSeconds: start, EndSeconds: end}
	}

	t.Run("no chunks -> ok=false", func(t *testing.T) {
		if _, ok := chunkForSeconds(nil, 5); ok {
			t.Error("want ok=false when there are no chunks")
		}
	})
	t.Run("unsorted input still range-matches (sort defense)", func(t *testing.T) {
		// chunk 2 [100,200) listed BEFORE chunk 1 [0,100): without the sort the
		// "last started" fallback would mis-attribute.
		chunks := []gen.LessonTranscriptChunk{mk(2, 100, 200), mk(1, 0, 100)}
		got, ok := chunkForSeconds(chunks, 50)
		if !ok || got != tuid(1) {
			t.Errorf("seconds=50 should match chunk 1; got %v ok=%v", got, ok)
		}
	})
	t.Run("before the first chunk -> first", func(t *testing.T) {
		chunks := []gen.LessonTranscriptChunk{mk(1, 10, 20), mk(2, 20, 30)}
		if got, _ := chunkForSeconds(chunks, 5); got != tuid(1) {
			t.Errorf("before-first should return chunk 1; got %v", got)
		}
	})
	t.Run("gap and past-last -> last started", func(t *testing.T) {
		chunks := []gen.LessonTranscriptChunk{mk(1, 0, 10), mk(2, 20, 30)}
		if got, _ := chunkForSeconds(chunks, 15); got != tuid(1) { // in the [10,20) gap
			t.Errorf("gap should return last-started (chunk 1); got %v", got)
		}
		if got, _ := chunkForSeconds(chunks, 99); got != tuid(2) { // past the last
			t.Errorf("past-last should return chunk 2; got %v", got)
		}
	})
}

func TestOptionStatsByInteraction(t *testing.T) {
	t.Parallel()
	mcqID := tuid(1)
	cfg, _ := json.Marshal(singleChoiceConfig{Options: []string{"A", "B", "C"}, CorrectAnswer: 1})
	interactions := map[string]gen.LessonInteraction{
		mcqID.String(): {ID: mcqID, Kind: "mcq", Config: cfg},
	}
	rows := []gen.LessonMcqOptionDistributionRow{
		{InteractionID: mcqID, OptionIndex: 1, ChosenCount: 3}, // correct
		{InteractionID: mcqID, OptionIndex: 0, ChosenCount: 1}, // wrong
		{InteractionID: mcqID, OptionIndex: 9, ChosenCount: 1}, // out of range
	}
	out := optionStatsByInteraction(rows, interactions)
	opts := out[mcqID.String()]
	// Every config option (A,B,C) is emitted — even C, which nobody chose — plus
	// the out-of-range index 9 that was selected, preserved at the end.
	if len(opts) != 4 {
		t.Fatalf("want 4 option stats (3 config + 1 out-of-range), got %d", len(opts))
	}
	byIdx := map[int32]*richterv1.McqOptionStat{}
	for _, o := range opts {
		byIdx[o.OptionIndex] = o
	}
	if !byIdx[1].IsCorrect || byIdx[1].OptionText != "B" || byIdx[1].ChosenCount != 3 {
		t.Errorf("option 1 should be correct with text B, count 3; got %+v", byIdx[1])
	}
	if byIdx[0].IsCorrect || byIdx[0].OptionText != "A" || byIdx[0].ChosenCount != 1 {
		t.Errorf("option 0 should be wrong with text A, count 1; got %+v", byIdx[0])
	}
	// Option C drew zero responses but must still be present (else a 0-pick
	// correct answer would be invisible to the teacher).
	if byIdx[2] == nil || byIdx[2].OptionText != "C" || byIdx[2].ChosenCount != 0 || byIdx[2].IsCorrect {
		t.Errorf("unchosen option 2 (C, count 0) must still be emitted; got %+v", byIdx[2])
	}
	if byIdx[9].OptionText != "" || byIdx[9].ChosenCount != 1 {
		t.Errorf("out-of-range option index should be preserved with empty text; got %+v", byIdx[9])
	}

	t.Run("missing/unparseable config -> no option flagged correct", func(t *testing.T) {
		// interaction id absent from the map → default CorrectAnswer -1.
		got := optionStatsByInteraction(
			[]gen.LessonMcqOptionDistributionRow{{InteractionID: tuid(2), OptionIndex: 0, ChosenCount: 1}},
			map[string]gen.LessonInteraction{},
		)
		for _, o := range got[tuid(2).String()] {
			if o.IsCorrect {
				t.Errorf("no option should be correct when config is missing")
			}
		}
	})
}

func TestBuildQuestionStats(t *testing.T) {
	t.Parallel()
	mcqID, fillID, goneID := tuid(1), tuid(2), tuid(3)
	interactions := map[string]gen.LessonInteraction{
		// fill is EARLIER in time than mcq, to exercise chronological ordering.
		fillID.String(): {ID: fillID, Kind: "fill_blank", Prompt: "fill?", StartSeconds: 10},
		mcqID.String():  {ID: mcqID, Kind: "mcq", Prompt: "mcq?", StartSeconds: 50},
	}
	rows := []gen.LessonQuestionStatsRow{
		{InteractionID: mcqID, ResponseCount: 4, Accuracy: 0.75},
		{InteractionID: fillID, ResponseCount: 3, Accuracy: 0.333},
		{InteractionID: goneID, ResponseCount: 2, Accuracy: 1}, // since-deleted interaction
	}
	optionsByID := map[string][]*richterv1.McqOptionStat{
		mcqID.String(): {{OptionIndex: 0, ChosenCount: 4, IsCorrect: true}},
	}

	out := buildQuestionStats(rows, interactions, optionsByID)

	if len(out) != 2 {
		t.Fatalf("want 2 question stats (since-deleted dropped), got %d", len(out))
	}
	// Ordered by StartSeconds: fill (10) before mcq (50).
	if out[0].InteractionId != fillID.String() || out[1].InteractionId != mcqID.String() {
		t.Errorf("want chronological order [fill, mcq]; got [%s, %s]", out[0].Kind, out[1].Kind)
	}
	// fill carries accuracy + count but NO options.
	if out[0].Kind != "fill_blank" || out[0].ResponseCount != 3 || len(out[0].Options) != 0 {
		t.Errorf("fill question wrong: %+v", out[0])
	}
	if out[0].Accuracy < 0.33 || out[0].Accuracy > 0.34 {
		t.Errorf("fill accuracy: want ~0.333, got %v", out[0].Accuracy)
	}
	// mcq carries its option distribution.
	if out[1].Kind != "mcq" || len(out[1].Options) != 1 {
		t.Errorf("mcq question should carry options; got %+v", out[1])
	}
}

// TestComputeEngagementScore guards the engagement formula after dropping the
// meaningless response-rate term: score = round(100 * (0.5*watch + 0.5*score)),
// each input clamped to [0,1]. Response rate is no longer an input because every
// question must be answered to submit, so it was ~always 1.0 and only inflated
// the score by a constant.
func TestComputeEngagementScore(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name        string
		watch, frac float64
		want        float64
	}{
		{"perfect", 1.0, 1.0, 100},
		{"zero", 0, 0, 0},
		{"watch only", 1.0, 0, 50},
		{"score only", 0, 1.0, 50},
		{"balanced 0.8/0.4", 0.8, 0.4, 60},
		{"half rounds away from zero (97.5->98)", 0.95, 1.0, 98},
		{"half rounds away from zero (12.5->13)", 0.25, 0.0, 13},
		{"clamps out-of-range inputs", 1.5, -0.5, 50},
		{"grace-like 0.78/0.8", 0.78, 0.8, 79},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := computeEngagementScore(c.watch, c.frac); got != c.want {
				t.Errorf("computeEngagementScore(%v, %v) = %v, want %v", c.watch, c.frac, got, c.want)
			}
		})
	}
}
