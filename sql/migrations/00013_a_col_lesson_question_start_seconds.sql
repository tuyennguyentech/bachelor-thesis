-- +goose Up
ALTER TABLE lesson_questions ADD COLUMN start_seconds float NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE lesson_questions DROP COLUMN start_seconds;
