-- +goose Up
ALTER TABLE lesson_analyses ADD COLUMN transcript_segments jsonb;

-- +goose Down
ALTER TABLE lesson_analyses DROP COLUMN transcript_segments;
