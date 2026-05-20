-- +goose Up
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS language varchar(8) NOT NULL DEFAULT 'vi';

-- +goose Down
ALTER TABLE lessons DROP COLUMN IF EXISTS language;
