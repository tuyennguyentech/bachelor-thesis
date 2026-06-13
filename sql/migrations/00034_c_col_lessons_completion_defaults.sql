-- Store the real completion-threshold defaults in the row (column DEFAULT) so a
-- value of 0 means "0% — no requirement" instead of being overloaded as "use
-- default". Previously NULLIF(x,0) in the analytics query could not tell an
-- intentional 0 from an unset value, so a teacher who set 0% silently got the
-- hidden 0.8/0.6 defaults. New lessons now get 0.8/0.6 from the column default;
-- existing rows whose 0 meant "use default" are backfilled to those defaults.

-- +goose Up
ALTER TABLE lessons
    ALTER COLUMN min_watch_fraction SET DEFAULT 0.8,
    ALTER COLUMN min_score_fraction SET DEFAULT 0.6;
UPDATE lessons SET min_watch_fraction = 0.8 WHERE min_watch_fraction = 0;
UPDATE lessons SET min_score_fraction = 0.6 WHERE min_score_fraction = 0;

-- +goose Down
ALTER TABLE lessons
    ALTER COLUMN min_watch_fraction SET DEFAULT 0,
    ALTER COLUMN min_score_fraction SET DEFAULT 0;
