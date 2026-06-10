package ai

import (
	"example.com/richter/internal/svc/ai/segment"
)

// FDB-load helpers for transcript + chunk data. These wrap the free
// functions in the segment sub-package so existing callers in this
// package (and its siblings) can keep using method syntax. The actual
// implementation lives in segment/ so the sub-packages can share it.

func (s *AISvc) loadTranscriptFromFDB(lessonIDStr string) string {
	return segment.LoadTranscript(s.kv, lessonIDStr)
}

func (s *AISvc) loadSegmentsFromFDB(lessonIDStr string) []transcriptSegment {
	return segment.LoadSegments(s.kv, lessonIDStr)
}

func (s *AISvc) fetchChunkTranscript(chunkIDStr string) string {
	return segment.FetchChunkTranscript(s.kv, chunkIDStr)
}
