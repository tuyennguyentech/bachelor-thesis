-- +goose Up
DROP TABLE IF EXISTS quiz_attempts;
DROP TABLE IF EXISTS lesson_questions;

-- +goose Down
-- Cannot restore dropped data; re-create empty tables for rollback only
CREATE TABLE IF NOT EXISTS lesson_questions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL,
  question_text text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  correct_answer integer NOT NULL DEFAULT 0,
  explanation text,
  order_index integer NOT NULL DEFAULT 0,
  start_seconds real NOT NULL DEFAULT 0,
  chunk_id uuid,
  created_at timestamp DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL,
  user_id uuid NOT NULL,
  answers jsonb NOT NULL DEFAULT '[]',
  score integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  submitted_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  UNIQUE (lesson_id, user_id)
);
