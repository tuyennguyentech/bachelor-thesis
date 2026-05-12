-- +goose Up
CREATE TYPE course_status AS ENUM (
  'draft',
  'published',
  'archived'
);

CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description text,
  status course_status NOT NULL DEFAULT 'draft',
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX courses_organization_id_idx ON courses(organization_id);
CREATE INDEX courses_owner_id_idx ON courses(owner_id);

CREATE OR REPLACE TRIGGER courses_set_updated_at
BEFORE UPDATE ON courses
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS courses_set_updated_at ON courses;

DROP INDEX IF EXISTS courses_owner_id_idx;
DROP INDEX IF EXISTS courses_organization_id_idx;

DROP TABLE IF EXISTS courses;

DROP TYPE IF EXISTS course_status;
