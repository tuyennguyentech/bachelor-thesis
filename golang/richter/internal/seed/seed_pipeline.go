package seed

import (
	"context"
	"encoding/json"
	"fmt"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/richter/internal/svc/ai/transcript"
)

// This file wires the dev seeder into the REAL transcript pipeline
// (transcript.Service) with the AI boundaries replaced by golden fixtures built
// from the curated seed JSON. RunExtract + RunChunk then run the exact same
// persistence logic a real Whisper/Gemini run would, so seeded
// lessons are consistent-by-construction (no FDB/Postgres divergence) without any
// network calls or non-determinism.

// seedSTTRunner is the golden-fixture replacement for the STT (Whisper) boundary:
// it returns the curated transcript and length-distributed segments instead of
// transcribing audio. transcript.Service.RunExtract persists these to FDB exactly
// as a real run would.
func seedSTTRunner(transcriptText string, totalDur float64) transcript.STTRunner {
	return func(_ context.Context, _ string, _ string, _ transcript.ProgressFn) (string, []segment.Segment, error) {
		return transcriptText, deriveSeedSegments(transcriptText, totalDur), nil
	}
}

// seedChunkRunner is the golden-fixture replacement for the Gemini chunking
// boundary: it replays the curated chunk boundaries (encoded as the exact Gemini
// chunk-response JSON) instead of calling the model. Parsing mirrors the
// production chunk parser so the fixture stays schema-faithful.
func seedChunkRunner(chunkJSON string) transcript.ChunkRunner {
	return func(_ context.Context, _ string, _ []byte, _ string) ([]transcript.ChunkProposal, error) {
		var parsed struct {
			Chunks []struct {
				Summary      string  `json:"summary"`
				StartSeconds float32 `json:"start_seconds"`
				EndSeconds   float32 `json:"end_seconds"`
			} `json:"chunks"`
		}
		if err := json.Unmarshal([]byte(chunkJSON), &parsed); err != nil {
			return nil, fmt.Errorf("seed chunk fixture: %w", err)
		}
		out := make([]transcript.ChunkProposal, len(parsed.Chunks))
		for i, c := range parsed.Chunks {
			out[i] = transcript.ChunkProposal{
				StartSeconds: c.StartSeconds,
				EndSeconds:   c.EndSeconds,
				Summary:      c.Summary,
			}
		}
		return out, nil
	}
}

// buildSeedChunkJSON encodes curated chunks into the exact JSON shape the chunk
// pipeline expects from Gemini ({"chunks":[{summary,start_seconds,end_seconds}]}).
// Marshalling here (and parsing back in seedChunkRunner) keeps the seed fixture a
// faithful stand-in for a recorded Gemini response.
func buildSeedChunkJSON(chunks []devChunkSpec) (string, error) {
	type chunkJSON struct {
		Summary      string  `json:"summary"`
		StartSeconds float64 `json:"start_seconds"`
		EndSeconds   float64 `json:"end_seconds"`
	}
	out := struct {
		Chunks []chunkJSON `json:"chunks"`
	}{}
	for _, ch := range chunks {
		out.Chunks = append(out.Chunks, chunkJSON{
			Summary:      ch.Summary,
			StartSeconds: ch.StartSeconds,
			EndSeconds:   ch.EndSeconds,
		})
	}
	b, err := json.Marshal(out)
	return string(b), err
}

// noopLocker satisfies transcript.LessonLocker for the seeder: seeding is
// single-threaded per lesson, so no real per-lesson mutex is needed.
type noopLocker struct{}

func (noopLocker) TryAcquire(string) (transcript.LessonLock, bool) { return struct{}{}, true }
func (noopLocker) Release(string, transcript.LessonLock)           {}

// noopProgress is the no-op progress callback for seed-time pipeline runs.
func noopProgress(richterv1.AnalysisProgressStep, string) error { return nil }

// newSeedTranscriptService builds a real transcript.Service whose AI boundaries
// (STT + chunking) are backed by golden fixtures, so RunExtract/RunChunk run the
// real persistence logic against curated content. The auth Deps are
// left nil — RunExtract/RunChunk never touch them — and the list-limit closures
// are generous fixed values (seed data is small).
func (s *SeederSvc) newSeedTranscriptService(transcriptText string, totalDur float64, chunkJSON string) *transcript.Service {
	return transcript.New(transcript.Deps{
		Postgres:       s.pg,
		KV:             s.kv,
		Log:            s.log,
		Transcription:  seedSTTRunner(transcriptText, totalDur),
		Chunk:          seedChunkRunner(chunkJSON),
		Locks:          noopLocker{},
		ChunksLimit:    func() int32 { return 5000 },
		LessonOpsLimit: func() int32 { return 10000 },
	})
}
