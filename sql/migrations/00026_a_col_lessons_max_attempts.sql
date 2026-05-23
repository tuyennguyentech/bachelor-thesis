-- +goose Up
ALTER TABLE lessons ADD COLUMN max_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE lesson_attempts ADD COLUMN attempt_count integer NOT NULL DEFAULT 1;

-- +goose Down
ALTER TABLE lesson_attempts DROP COLUMN IF EXISTS attempt_count;
ALTER TABLE lessons DROP COLUMN IF EXISTS max_attempts;
