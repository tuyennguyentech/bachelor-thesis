-- +goose Up
CREATE TYPE course_role AS ENUM (
  'teacher',
  'student'
);

CREATE TABLE course_members (
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       course_role NOT NULL DEFAULT 'student',
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  PRIMARY KEY (course_id, user_id)
);

CREATE INDEX course_members_course_id_idx ON course_members(course_id);
CREATE INDEX course_members_user_id_idx ON course_members(user_id);

CREATE OR REPLACE TRIGGER course_members_set_updated_at
BEFORE UPDATE ON course_members
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS course_members_set_updated_at ON course_members;

DROP INDEX IF EXISTS course_members_user_id_idx;
DROP INDEX IF EXISTS course_members_course_id_idx;

DROP TABLE IF EXISTS course_members;

DROP TYPE IF EXISTS course_role;
