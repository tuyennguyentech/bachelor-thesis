-- +goose Up
CREATE TABLE lessons (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  module_id uuid NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX lessons_module_id_idx ON lessons(module_id);

CREATE OR REPLACE TRIGGER lessons_set_updated_at
BEFORE UPDATE ON lessons
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS lessons_set_updated_at ON lessons;

DROP INDEX IF EXISTS lessons_module_id_idx;

DROP TABLE IF EXISTS lessons;
