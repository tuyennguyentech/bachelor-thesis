-- Remove large text/JSON content columns from PG: all content is stored in FDB.
-- PG tables become metadata-only; FDB is the sole source of truth for transcript text.

-- +goose Up
ALTER TABLE lesson_analyses DROP COLUMN transcript;
ALTER TABLE lesson_analyses DROP COLUMN transcript_segments;
ALTER TABLE lesson_transcript_chunks DROP COLUMN transcript;

-- +goose Down
ALTER TABLE lesson_analyses ADD COLUMN transcript text;
ALTER TABLE lesson_analyses ADD COLUMN transcript_segments jsonb;
ALTER TABLE lesson_transcript_chunks ADD COLUMN transcript text NOT NULL DEFAULT '';
