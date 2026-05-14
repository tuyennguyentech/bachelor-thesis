package ai

import (
	"testing"
)

func segs(pairs ...float32) []transcriptSegment {
	out := make([]transcriptSegment, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, transcriptSegment{StartSeconds: pairs[i], EndSeconds: pairs[i+1], Text: "x"})
	}
	return out
}

// ── normalizeSegments ─────────────────────────────────────────────────────────

func TestNormalizeSegments_Empty(t *testing.T) {
	if got := normalizeSegments(nil, 100); len(got) != 0 {
		t.Fatalf("expected empty, got %v", got)
	}
}

func TestNormalizeSegments_NoDuration(t *testing.T) {
	// duration == 0: no rescaling, no filtering — return sorted as-is.
	in := segs(5, 10, 0, 5)
	got := normalizeSegments(in, 0)
	if len(got) != 2 {
		t.Fatalf("expected 2 segments, got %d", len(got))
	}
	if got[0].StartSeconds != 0 {
		t.Errorf("expected sorted first seg start=0, got %v", got[0].StartSeconds)
	}
}

func TestNormalizeSegments_NoRescaleNeeded(t *testing.T) {
	// Timestamps close to duration — no rescaling expected.
	in := segs(0, 30, 30, 60, 60, 90)
	got := normalizeSegments(in, 90)
	if len(got) != 3 {
		t.Fatalf("expected 3, got %d", len(got))
	}
	if got[0].StartSeconds != 0 || got[2].StartSeconds != 60 {
		t.Errorf("unexpected timestamps after no-op normalize: %v", got)
	}
}

func TestNormalizeSegments_RescaleOvershoot(t *testing.T) {
	// Gemini reports segments up to 200s but video is 100s — should scale by 0.5.
	in := segs(0, 50, 50, 100, 100, 150, 150, 200)
	got := normalizeSegments(in, 100)
	// After scale 0.5: starts = 0, 25, 50, 75; all < 100 so all kept.
	if len(got) != 4 {
		t.Fatalf("expected 4 after rescale, got %d: %v", len(got), got)
	}
	if got[3].StartSeconds >= 100 {
		t.Errorf("expected last start < 100 after rescale, got %v", got[3].StartSeconds)
	}
}

func TestNormalizeSegments_DropSegmentsPastEnd(t *testing.T) {
	// One segment starts exactly at video end — should be dropped.
	in := segs(0, 50, 50, 100, 100, 120)
	got := normalizeSegments(in, 100)
	for _, s := range got {
		if s.StartSeconds >= 100 {
			t.Errorf("segment starting at %v should have been dropped", s.StartSeconds)
		}
	}
}

func TestNormalizeSegments_AllZeroTimestamps(t *testing.T) {
	// Gemini returns all-zero timestamps — geminiMax < 5 so rescaling is skipped.
	// Degenerate end times (end==start==0) are still fixed to start+15.
	in := segs(0, 0, 0, 0, 0, 0)
	got := normalizeSegments(in, 630)
	// StartSeconds should remain near 0 (not blown up to hundreds).
	for _, s := range got {
		if s.StartSeconds > 1 {
			t.Errorf("all-zero start timestamps should not be rescaled, got start=%v", s.StartSeconds)
		}
	}
}

func TestNormalizeSegments_RescaleUndershoot(t *testing.T) {
	// Gemini covers only 33% of the video — geminiMax(30) < duration*0.5(45) → scale up by 3.
	in := segs(0, 10, 10, 20, 20, 30)
	got := normalizeSegments(in, 90)
	if len(got) != 3 {
		t.Fatalf("expected 3, got %d", len(got))
	}
	// After scale 3: starts = 0, 30, 60.
	if got[2].StartSeconds < 59 || got[2].StartSeconds > 61 {
		t.Errorf("expected last start ~60 after scale-up, got %v", got[2].StartSeconds)
	}
}

func TestNormalizeSegments_FixDegenerateEndTimes(t *testing.T) {
	// Segment with end < start survives the filter (start < duration) and gets end = start+15.
	// duration=15: geminiMax=9, in range [7.5, 15.75] → no rescaling; start=10 < 15 → kept.
	in := []transcriptSegment{{StartSeconds: 10, EndSeconds: 9, Text: "x"}}
	got := normalizeSegments(in, 15)
	if len(got) == 0 {
		t.Fatal("expected segment to survive filter")
	}
	if got[0].EndSeconds <= got[0].StartSeconds {
		t.Errorf("degenerate end time not fixed: start=%v end=%v", got[0].StartSeconds, got[0].EndSeconds)
	}
}

// ── buildChunkTranscript ──────────────────────────────────────────────────────

func TestBuildChunkTranscript_Basic(t *testing.T) {
	segs := []transcriptSegment{
		{StartSeconds: 0, EndSeconds: 10, Text: "hello"},
		{StartSeconds: 10, EndSeconds: 20, Text: "world"},
		{StartSeconds: 20, EndSeconds: 30, Text: "end"},
	}
	got := buildChunkTranscript(segs, 0, 20)
	if got != "hello world" {
		t.Errorf("want %q, got %q", "hello world", got)
	}
}

func TestBuildChunkTranscript_ExcludeAtEnd(t *testing.T) {
	// Segment starting exactly at endSec should be excluded.
	segs := []transcriptSegment{
		{StartSeconds: 10, EndSeconds: 20, Text: "a"},
		{StartSeconds: 20, EndSeconds: 30, Text: "b"},
	}
	got := buildChunkTranscript(segs, 10, 20)
	if got != "a" {
		t.Errorf("want %q, got %q", "a", got)
	}
}

func TestBuildChunkTranscript_Empty(t *testing.T) {
	got := buildChunkTranscript(nil, 0, 100)
	if got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

func TestBuildChunkTranscript_NoMatch(t *testing.T) {
	segs := []transcriptSegment{{StartSeconds: 50, EndSeconds: 60, Text: "x"}}
	got := buildChunkTranscript(segs, 0, 40)
	if got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}
