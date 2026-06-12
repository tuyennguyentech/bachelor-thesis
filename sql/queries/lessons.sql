-- name: CreateLesson :one
INSERT INTO lessons (module_id, title, description, order_index, max_attempts)
VALUES ($1, $2, $3, $4, $5)
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
SET title = $2, description = $3, order_index = $4, language = $5, max_attempts = $6,
    min_watch_fraction = $7, min_score_fraction = $8
WHERE id = $1
RETURNING *;

-- name: UpdateLessonVideo :one
UPDATE lessons
SET video_storage_key = $2, duration_seconds = $3
WHERE id = $1
RETURNING *;

-- name: DeleteLesson :execrows
DELETE FROM lessons WHERE id = $1;

-- name: GetOrgIDByLessonID :one
SELECT c.organization_id
FROM lessons l
JOIN course_modules cm ON cm.id = l.module_id
JOIN courses c ON c.id = cm.course_id
WHERE l.id = $1;

-- name: UpdateLessonFeedbackMode :one
UPDATE lessons SET feedback_mode = $2 WHERE id = $1 RETURNING *;

-- name: UpdateLessonDefaultInteractionConfig :one
UPDATE lessons SET default_interaction_config = $2 WHERE id = $1 RETURNING *;
