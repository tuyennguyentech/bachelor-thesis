-- +goose Up
ALTER TABLE lessons ADD COLUMN video_storage_key text;
ALTER TABLE lessons ADD COLUMN duration_seconds integer;

-- +goose Down
ALTER TABLE lessons DROP COLUMN IF EXISTS duration_seconds;
ALTER TABLE lessons DROP COLUMN IF EXISTS video_storage_key;
