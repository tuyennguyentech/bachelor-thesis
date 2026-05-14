-- +goose Up
ALTER TYPE lesson_analysis_status ADD VALUE IF NOT EXISTS 'transcript_extracted';

-- +goose Down
-- PostgreSQL does not support removing enum values without recreating the type.
-- This migration cannot be reversed.
