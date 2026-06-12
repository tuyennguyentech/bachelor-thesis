-- +goose Up
ALTER TABLE lessons
    ADD COLUMN min_watch_fraction real NOT NULL DEFAULT 0,
    ADD COLUMN min_score_fraction real NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE lessons
    DROP COLUMN IF EXISTS min_score_fraction,
    DROP COLUMN IF EXISTS min_watch_fraction;
