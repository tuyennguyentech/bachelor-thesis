-- +goose Up
CREATE TYPE lesson_analysis_status AS ENUM (
  'pending',
  'processing',
  'done',
  'error'
);

CREATE TABLE lesson_analyses (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  status lesson_analysis_status NOT NULL DEFAULT 'pending',
  transcript text,
  error_msg text,
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  UNIQUE (lesson_id)
);

CREATE OR REPLACE TRIGGER lesson_analyses_set_updated_at
BEFORE UPDATE ON lesson_analyses
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE lesson_questions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  question_text text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  correct_answer integer NOT NULL DEFAULT 0,
  explanation text,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX lesson_questions_lesson_id_idx ON lesson_questions(lesson_id);

-- +goose Down
DROP INDEX IF EXISTS lesson_questions_lesson_id_idx;
DROP TABLE IF EXISTS lesson_questions;
DROP TRIGGER IF EXISTS lesson_analyses_set_updated_at ON lesson_analyses;
DROP TABLE IF EXISTS lesson_analyses;
DROP TYPE IF EXISTS lesson_analysis_status;
