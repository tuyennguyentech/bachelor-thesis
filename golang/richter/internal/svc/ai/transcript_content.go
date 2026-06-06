package ai

import (
	"encoding/json"
	"strings"

	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
)

type transcriptSegment struct {
	StartSeconds float32 `json:"start_seconds"`
	EndSeconds   float32 `json:"end_seconds"`
	Text         string  `json:"text"`
}

// loadTranscriptFromFDB reads the full transcript text for a lesson from FDB.
func (s *AISvc) loadTranscriptFromFDB(lessonIDStr string) string {
	data, _ := s.kv.Get(kvNsLesson, tuple.Tuple{lessonIDStr, "transcript"})
	return strings.TrimSpace(string(data))
}

// loadSegmentsFromFDB reads transcript segments for a lesson from FDB.
func (s *AISvc) loadSegmentsFromFDB(lessonIDStr string) []transcriptSegment {
	data, _ := s.kv.Get(kvNsLesson, tuple.Tuple{lessonIDStr, "segments"})
	if len(data) == 0 {
		return nil
	}
	var segs []transcriptSegment
	_ = json.Unmarshal(data, &segs)
	return segs
}

// fetchChunkTranscript reads chunk transcript text from FDB.
func (s *AISvc) fetchChunkTranscript(chunkIDStr string) string {
	data, _ := s.kv.Get(kvNsChunk, tuple.Tuple{chunkIDStr, "transcript"})
	return strings.TrimSpace(string(data))
}

// buildChunkTranscript concatenates segment texts within [startSec, endSec) from the given segment list.
func buildChunkTranscript(segs []transcriptSegment, startSec, endSec float32) string {
	var b strings.Builder
	for _, seg := range segs {
		if seg.StartSeconds >= startSec && seg.StartSeconds < endSec {
			b.WriteString(seg.Text)
			b.WriteString(" ")
		}
	}
	return strings.TrimSpace(b.String())
}
