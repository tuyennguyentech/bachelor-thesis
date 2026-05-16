-- name: CreateCourse :one
INSERT INTO courses (organization_id, owner_id, title, description)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetCourseByID :one
SELECT * FROM courses WHERE id = $1;

-- name: ListCoursesByOrg :many
SELECT * FROM courses
WHERE organization_id = $1
ORDER BY created_at DESC, id DESC
LIMIT $2 OFFSET $3;

-- name: ListCoursesByOrgAndStatus :many
SELECT * FROM courses
WHERE organization_id = $1 AND status = $2
ORDER BY created_at DESC, id DESC
LIMIT $3 OFFSET $4;

-- name: ListCoursesByOrgAndTitleFilter :many
SELECT * FROM courses
WHERE organization_id = $1 AND title ILIKE '%' || $2::text || '%'
ORDER BY created_at DESC, id DESC
LIMIT $3 OFFSET $4;

-- name: UpdateCourse :one
UPDATE courses
SET title = $2, description = $3
WHERE id = $1
RETURNING *;

-- name: UpdateCourseStatus :one
UPDATE courses
SET status = $2
WHERE id = $1
RETURNING *;

-- name: DeleteCourse :execrows
DELETE FROM courses WHERE id = $1;
