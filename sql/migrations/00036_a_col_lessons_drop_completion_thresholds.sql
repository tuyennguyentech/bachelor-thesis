-- Drop the lesson completion-threshold columns. The "completion conditions"
-- feature (a lesson is "passed" only if watch% >= min_watch_fraction AND
-- score% >= min_score_fraction) was never useful: every lesson silently
-- defaulted to 0.8/0.6, so progress dashboards showed "0% passed" for students
-- who had clearly attempted lessons. The mastery metric is removed entirely;
-- progress is now a single "attempted lessons" count.

-- +goose Up
ALTER TABLE lessons
    DROP COLUMN IF EXISTS min_watch_fraction,
    DROP COLUMN IF EXISTS min_score_fraction;

-- +goose Down
ALTER TABLE lessons
    ADD COLUMN min_watch_fraction real NOT NULL DEFAULT 0.8,
    ADD COLUMN min_score_fraction real NOT NULL DEFAULT 0.6;
