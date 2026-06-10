// Package segment owns the transcript segment data type and the pure helpers
// that operate on it. It also exposes the FDB namespace constants and the
// load/save helpers used by every consumer of transcript data, so the
// sub-packages below don't each redeclare them.
package segment

// Segment is one timestamped chunk of a lesson's transcript. Times are in
// seconds from the start of the video. Text is the verbatim caption returned
// by Whisper (or the user, after editing a segment). The in-memory type
// carries no JSON tags because FDB storage uses the FdbTranscriptSegment
// proto wrapper defined in proto/richter/v1/fdb_records.proto.
type Segment struct {
	StartSeconds float32
	EndSeconds   float32
	Text         string
}
