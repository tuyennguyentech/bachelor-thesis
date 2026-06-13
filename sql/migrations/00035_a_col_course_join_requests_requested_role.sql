-- +goose Up
-- Requested course role for a join request. STUDENT = request to learn
-- (Thành viên); TEACHER = request to manage (Quản lý). Reuses the existing
-- course_role enum. Existing rows default to 'student' (the prior behaviour).
ALTER TABLE course_join_requests
  ADD COLUMN requested_role course_role NOT NULL DEFAULT 'student';

-- +goose Down
ALTER TABLE course_join_requests
  DROP COLUMN IF EXISTS requested_role;
