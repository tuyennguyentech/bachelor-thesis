-- name: CreateCourseModule :one
INSERT INTO course_modules (course_id, title, order_index)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetCourseModuleByID :one
SELECT * FROM course_modules WHERE id = $1;

-- name: ListCourseModules :many
SELECT * FROM course_modules
WHERE course_id = $1
ORDER BY order_index ASC, id ASC
LIMIT $2 OFFSET $3;

-- name: UpdateCourseModule :one
UPDATE course_modules
SET title = $2, order_index = $3
WHERE id = $1
RETURNING *;

-- name: DeleteCourseModule :execrows
DELETE FROM course_modules WHERE id = $1;

-- name: GetOrgIDByCourseModuleID :one
SELECT c.organization_id
FROM course_modules cm
JOIN courses c ON c.id = cm.course_id
WHERE cm.id = $1;
