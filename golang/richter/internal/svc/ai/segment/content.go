package segment

import "strings"

// BuildChunkTranscript concatenates segment texts whose StartSeconds falls
// within [startSec, endSec). Half-open on the upper bound to avoid double-
// counting a segment whose start equals the boundary.
func BuildChunkTranscript(segs []Segment, startSec, endSec float32) string {
	var b strings.Builder
	for _, seg := range segs {
		if seg.StartSeconds >= startSec && seg.StartSeconds < endSec {
			b.WriteString(seg.Text)
			b.WriteString(" ")
		}
	}
	return strings.TrimSpace(b.String())
}

// ChunkSegments filters the full segment list down to those inside the
// [start, end) window. Matches BuildChunkTranscript's half-open semantics.
func ChunkSegments(segs []Segment, start, end float32) []Segment {
	out := make([]Segment, 0)
	for _, s := range segs {
		if s.StartSeconds >= start && s.StartSeconds < end {
			out = append(out, s)
		}
	}
	return out
}
