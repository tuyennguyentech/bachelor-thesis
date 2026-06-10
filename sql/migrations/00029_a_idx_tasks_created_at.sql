-- +goose Up
CREATE INDEX tasks_created_at_idx ON tasks(created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS tasks_created_at_idx;
