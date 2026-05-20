-- +goose Up
DELETE FROM lesson_interactions WHERE kind = 'reading';

-- +goose Down
-- (legacy reading data is not restored on rollback)
