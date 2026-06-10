package segment

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/kv"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"google.golang.org/protobuf/proto"
)

// FDB namespace identifiers used by every transcript/chunk/lesson
// record. Centralised here so callers don't each redeclare them.
const (
	NsLesson = "lesson"
	NsChunk  = "chunk"
	NsWatch  = "watch"
)

// LoadTranscript reads the full transcript text for a lesson from FDB.
// Returns an empty string if the lesson has no transcript yet.
func LoadTranscript(kvSvc *kv.KVSvc, lessonIDStr string) string {
	return strings.TrimSpace(loadTranscriptProto(kvSvc, NsLesson, lessonIDStr).GetText())
}

// LoadSegments reads the per-segment list for a lesson from FDB. Returns
// nil if the lesson has no segments stored yet.
func LoadSegments(kvSvc *kv.KVSvc, lessonIDStr string) []Segment {
	data, _ := kvSvc.Get(NsLesson, tuple.Tuple{lessonIDStr, "segments"})
	if len(data) == 0 {
		return nil
	}
	blob := &richterv1.FdbSegmentsBlob{}
	if err := proto.Unmarshal(data, blob); err != nil {
		return segmentsFromLegacyJSON(data)
	}
	return segmentsFromProto(blob.GetSegments())
}

// LoadSegmentsPromptJSON returns a UTF-8 JSON payload suitable for Gemini
// prompts. FDB stores new records as FdbSegmentsBlob protobuf, while older
// tests/dev data may still contain the legacy JSON array.
func LoadSegmentsPromptJSON(kvSvc *kv.KVSvc, lessonIDStr string) []byte {
	data, _ := kvSvc.Get(NsLesson, tuple.Tuple{lessonIDStr, "segments"})
	if len(data) == 0 {
		return nil
	}
	if json.Valid(data) && utf8.Valid(data) {
		return data
	}
	segs := LoadSegments(kvSvc, lessonIDStr)
	if len(segs) == 0 {
		return nil
	}
	out, err := json.Marshal(segmentsToLegacyJSON(segs))
	if err != nil {
		return nil
	}
	return out
}

// FetchChunkTranscript reads chunk transcript text from FDB. Empty if the
// chunk has not been written yet (e.g. before the chunk pipeline runs).
func FetchChunkTranscript(kvSvc *kv.KVSvc, chunkIDStr string) string {
	return strings.TrimSpace(loadTranscriptProto(kvSvc, NsChunk, chunkIDStr).GetText())
}

// SaveTranscript writes the rebuilt transcript text to FDB.
func SaveTranscript(kvSvc *kv.KVSvc, lessonIDStr, transcript string) error {
	return saveTranscriptProto(kvSvc, NsLesson, lessonIDStr, transcript)
}

// SaveSegments writes the segment list to FDB.
func SaveSegments(kvSvc *kv.KVSvc, lessonIDStr string, segs []Segment) error {
	blob := &richterv1.FdbSegmentsBlob{Segments: segmentsToProto(segs)}
	data, err := proto.Marshal(blob)
	if err != nil {
		return err
	}
	return kvSvc.Set(NsLesson, tuple.Tuple{lessonIDStr, "segments"}, data)
}

// SaveChunkTranscript writes a chunk's transcript text to FDB.
func SaveChunkTranscript(kvSvc *kv.KVSvc, chunkIDStr, text string) error {
	return saveTranscriptProto(kvSvc, NsChunk, chunkIDStr, text)
}

// DeleteChunkTranscript removes a chunk's transcript from FDB.
func DeleteChunkTranscript(kvSvc *kv.KVSvc, chunkIDStr string) error {
	return kvSvc.Delete(NsChunk, tuple.Tuple{chunkIDStr, "transcript"})
}

// DeleteLessonTranscripts removes both the lesson's transcript text and
// its segments from FDB. Used on re-extract to clear stale data.
func DeleteLessonTranscripts(kvSvc *kv.KVSvc, lessonIDStr string) {
	_ = kvSvc.Delete(NsLesson, tuple.Tuple{lessonIDStr, "transcript"})
	_ = kvSvc.Delete(NsLesson, tuple.Tuple{lessonIDStr, "segments"})
}

// ChunkToProtoKey returns the FDB key tuple for a chunk's transcript.
// Exposed so callers that need to build the key without writing (e.g.
// to delete stale entries) don't have to duplicate the tuple layout.
func ChunkToProtoKey(chunkIDStr string) tuple.Tuple {
	return tuple.Tuple{chunkIDStr, "transcript"}
}

// ── internal helpers ────────────────────────────────────────────────────────

// loadTranscriptProto reads an FdbTranscript record from the given namespace
// and returns the decoded message. Returns a zero-value (non-nil) message
// on miss or decode error so callers can use GetText() / GetLanguage()
// without nil checks.
func loadTranscriptProto(kvSvc *kv.KVSvc, ns, idStr string) *richterv1.FdbTranscript {
	data, _ := kvSvc.Get(ns, tuple.Tuple{idStr, "transcript"})
	if len(data) == 0 {
		return &richterv1.FdbTranscript{}
	}
	rec := &richterv1.FdbTranscript{}
	if err := proto.Unmarshal(data, rec); err != nil {
		if utf8.Valid(data) {
			return &richterv1.FdbTranscript{Text: string(data)}
		}
		return &richterv1.FdbTranscript{}
	}
	return rec
}

// saveTranscriptProto marshals and writes a one-field FdbTranscript record.
func saveTranscriptProto(kvSvc *kv.KVSvc, ns, idStr, text string) error {
	data, err := proto.Marshal(&richterv1.FdbTranscript{Text: text})
	if err != nil {
		return err
	}
	return kvSvc.Set(ns, tuple.Tuple{idStr, "transcript"}, data)
}

func segmentsToProto(segs []Segment) []*richterv1.FdbTranscriptSegment {
	if len(segs) == 0 {
		return nil
	}
	out := make([]*richterv1.FdbTranscriptSegment, 0, len(segs))
	for _, s := range segs {
		out = append(out, &richterv1.FdbTranscriptSegment{
			StartSeconds: s.StartSeconds,
			EndSeconds:   s.EndSeconds,
			Text:         s.Text,
		})
	}
	return out
}

func segmentsFromProto(in []*richterv1.FdbTranscriptSegment) []Segment {
	if len(in) == 0 {
		return nil
	}
	out := make([]Segment, 0, len(in))
	for _, s := range in {
		if s == nil {
			continue
		}
		out = append(out, Segment{
			StartSeconds: s.GetStartSeconds(),
			EndSeconds:   s.GetEndSeconds(),
			Text:         s.GetText(),
		})
	}
	return out
}

type legacySegmentJSON struct {
	StartSeconds float32 `json:"start_seconds"`
	EndSeconds   float32 `json:"end_seconds"`
	Text         string  `json:"text"`
}

func segmentsFromLegacyJSON(data []byte) []Segment {
	var raw []legacySegmentJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	out := make([]Segment, 0, len(raw))
	for _, s := range raw {
		out = append(out, Segment{
			StartSeconds: s.StartSeconds,
			EndSeconds:   s.EndSeconds,
			Text:         s.Text,
		})
	}
	return out
}

func segmentsToLegacyJSON(segs []Segment) []legacySegmentJSON {
	if len(segs) == 0 {
		return nil
	}
	out := make([]legacySegmentJSON, 0, len(segs))
	for _, s := range segs {
		out = append(out, legacySegmentJSON{
			StartSeconds: s.StartSeconds,
			EndSeconds:   s.EndSeconds,
			Text:         s.Text,
		})
	}
	return out
}
