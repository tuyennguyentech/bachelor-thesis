-- +goose Up
CREATE TYPE join_request_status AS ENUM (
  'pending',
  'approved',
  'rejected'
);

CREATE TABLE course_join_requests (
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     join_request_status NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  PRIMARY KEY (course_id, user_id)
);

CREATE INDEX course_join_requests_course_id_idx ON course_join_requests(course_id);
CREATE INDEX course_join_requests_user_id_idx ON course_join_requests(user_id);

CREATE OR REPLACE TRIGGER course_join_requests_set_updated_at
BEFORE UPDATE ON course_join_requests
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS course_join_requests_set_updated_at ON course_join_requests;
DROP INDEX IF EXISTS course_join_requests_user_id_idx;
DROP INDEX IF EXISTS course_join_requests_course_id_idx;
DROP TABLE IF EXISTS course_join_requests;
DROP TYPE IF EXISTS join_request_status;
