-- +goose Up
CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '[]',
  score integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  submitted_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  UNIQUE (lesson_id, user_id)
);

CREATE INDEX quiz_attempts_lesson_id_idx ON quiz_attempts(lesson_id);
CREATE INDEX quiz_attempts_user_id_idx ON quiz_attempts(user_id);

-- +goose Down
DROP INDEX IF EXISTS quiz_attempts_user_id_idx;
DROP INDEX IF EXISTS quiz_attempts_lesson_id_idx;
DROP TABLE IF EXISTS quiz_attempts;
