package seed

import "testing"

func TestDeriveSeedSegments(t *testing.T) {
	t.Run("no duration yields no segments", func(t *testing.T) {
		if segs := deriveSeedSegments("Một câu. Hai câu.", 0); segs != nil {
			t.Errorf("expected nil for zero duration, got %d segments", len(segs))
		}
	})

	t.Run("splits into sentences covering the whole timeline in order", func(t *testing.T) {
		const total = 120.0
		segs := deriveSeedSegments("Câu một dài hơn một chút. Câu hai. Câu ba ngắn?", total)
		if len(segs) != 3 {
			t.Fatalf("expected 3 segments, got %d", len(segs))
		}
		// First starts at 0, last ends at totalDuration, and segments are
		// monotonically increasing and contiguous.
		if segs[0].StartSeconds != 0 {
			t.Errorf("first segment should start at 0, got %v", segs[0].StartSeconds)
		}
		if last := segs[len(segs)-1].EndSeconds; last < total-0.5 || last > total+0.5 {
			t.Errorf("last segment should end at ~%v, got %v", total, last)
		}
		for i, s := range segs {
			if s.EndSeconds < s.StartSeconds {
				t.Errorf("segment %d has end < start: %v < %v", i, s.EndSeconds, s.StartSeconds)
			}
			if s.Text == "" {
				t.Errorf("segment %d has empty text", i)
			}
			if i > 0 && s.StartSeconds < segs[i-1].StartSeconds {
				t.Errorf("segments out of order at %d", i)
			}
		}
	})

	t.Run("longer sentences get proportionally more time", func(t *testing.T) {
		segs := deriveSeedSegments("Ngắn. Đây là một câu dài hơn rất nhiều so với câu đầu tiên kia.", 100)
		if len(segs) != 2 {
			t.Fatalf("expected 2 segments, got %d", len(segs))
		}
		d0 := segs[0].EndSeconds - segs[0].StartSeconds
		d1 := segs[1].EndSeconds - segs[1].StartSeconds
		if d1 <= d0 {
			t.Errorf("expected the longer sentence to get more time: short=%v long=%v", d0, d1)
		}
	})
}
