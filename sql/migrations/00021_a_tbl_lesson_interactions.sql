-- +goose Up
CREATE TABLE lesson_interactions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES lesson_transcript_chunks(id) ON DELETE SET NULL,
  kind text NOT NULL,
  start_seconds real NOT NULL DEFAULT 0,
  order_index integer NOT NULL DEFAULT 0,
  prompt text NOT NULL,
  explanation text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}',
  max_score real NOT NULL DEFAULT 1.0,
  generated_by text NOT NULL DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lesson_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  total_score real NOT NULL DEFAULT 0,
  max_score real NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id)
);

CREATE TABLE lesson_attempt_responses (
  attempt_id uuid NOT NULL REFERENCES lesson_attempts(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES lesson_interactions(id) ON DELETE CASCADE,
  response jsonb NOT NULL DEFAULT '{}',
  score real NOT NULL DEFAULT 0,
  max_score real NOT NULL DEFAULT 1.0,
  feedback text NOT NULL DEFAULT '',
  PRIMARY KEY (attempt_id, interaction_id)
);

CREATE INDEX lesson_interactions_lesson_id_idx ON lesson_interactions(lesson_id);
CREATE INDEX lesson_attempts_lesson_id_idx ON lesson_attempts(lesson_id);
CREATE INDEX lesson_attempts_user_id_idx ON lesson_attempts(user_id);

-- +goose Down
DROP INDEX IF EXISTS lesson_attempts_user_id_idx;
DROP INDEX IF EXISTS lesson_attempts_lesson_id_idx;
DROP INDEX IF EXISTS lesson_interactions_lesson_id_idx;
DROP TABLE IF EXISTS lesson_attempt_responses;
DROP TABLE IF EXISTS lesson_attempts;
DROP TABLE IF EXISTS lesson_interactions;
