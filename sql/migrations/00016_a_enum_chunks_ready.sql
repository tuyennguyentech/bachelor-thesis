-- +goose Up
ALTER TYPE lesson_analysis_status ADD VALUE IF NOT EXISTS 'chunks_ready';

-- +goose Down
-- PostgreSQL does not support removing enum values; this migration is intentionally a no-op on down.
