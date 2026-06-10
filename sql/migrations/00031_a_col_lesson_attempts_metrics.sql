-- +goose Up
ALTER TABLE lesson_attempts
    ADD COLUMN started_at timestamptz,
    ADD COLUMN video_watch_fraction real;

ALTER TABLE lesson_attempt_responses
    ADD COLUMN time_to_answer_ms integer,
    ADD COLUMN replay_count integer NOT NULL DEFAULT 0,
    ADD COLUMN metrics jsonb;

-- +goose Down
ALTER TABLE lesson_attempt_responses
    DROP COLUMN IF EXISTS metrics,
    DROP COLUMN IF EXISTS replay_count,
    DROP COLUMN IF EXISTS time_to_answer_ms;

ALTER TABLE lesson_attempts
    DROP COLUMN IF EXISTS video_watch_fraction,
    DROP COLUMN IF EXISTS started_at;
