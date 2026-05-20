-- +goose Up
ALTER TABLE lessons ADD COLUMN feedback_mode text NOT NULL DEFAULT 'after_submit';

-- +goose Down
ALTER TABLE lessons DROP COLUMN feedback_mode;
