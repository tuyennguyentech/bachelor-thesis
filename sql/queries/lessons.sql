-- name: CreateLesson :one
INSERT INTO lessons (module_id, title, description, order_index)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetLessonByID :one
SELECT * FROM lessons WHERE id = $1;

-- name: ListLessons :many
SELECT * FROM lessons
WHERE module_id = $1
ORDER BY order_index ASC, id ASC
LIMIT $2 OFFSET $3;

-- name: ListLessonsByCourse :many
SELECT l.* FROM lessons l
JOIN course_modules cm ON l.module_id = cm.id
WHERE cm.course_id = $1
ORDER BY cm.order_index ASC, l.order_index ASC, l.id ASC
LIMIT $2 OFFSET $3;

-- name: UpdateLesson :one
UPDATE lessons
SET title = $2, description = $3, order_index = $4
WHERE id = $1
RETURNING *;

-- name: DeleteLesson :execrows
DELETE FROM lessons WHERE id = $1;
