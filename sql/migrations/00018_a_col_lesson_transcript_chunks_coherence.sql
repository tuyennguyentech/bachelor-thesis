-- +goose Up
ALTER TABLE lesson_transcript_chunks
  ADD COLUMN coherence_score real NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE lesson_transcript_chunks
  DROP COLUMN IF EXISTS coherence_score;
