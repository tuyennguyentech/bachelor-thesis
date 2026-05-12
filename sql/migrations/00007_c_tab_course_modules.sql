-- +goose Up
CREATE TABLE course_modules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX course_modules_course_id_idx ON course_modules(course_id);

CREATE OR REPLACE TRIGGER course_modules_set_updated_at
BEFORE UPDATE ON course_modules
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS course_modules_set_updated_at ON course_modules;

DROP INDEX IF EXISTS course_modules_course_id_idx;

DROP TABLE IF EXISTS course_modules;
