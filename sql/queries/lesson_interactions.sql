-- name: InsertLessonInteraction :one
INSERT INTO lesson_interactions (lesson_id, chunk_id, kind, start_seconds, order_index, prompt, explanation, config, max_score, generated_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: ListLessonInteractions :many
SELECT * FROM lesson_interactions
WHERE lesson_id = $1
ORDER BY order_index ASC, id ASC
LIMIT $2 OFFSET $3;

-- name: GetLessonInteractionByID :one
SELECT * FROM lesson_interactions WHERE id = $1;

-- name: UpdateLessonInteraction :one
UPDATE lesson_interactions
SET prompt = $2, explanation = $3, start_seconds = $4, config = $5, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteLessonInteraction :exec
DELETE FROM lesson_interactions WHERE id = $1;

-- name: DeleteLessonInteractionsByLesson :exec
DELETE FROM lesson_interactions WHERE lesson_id = $1;

-- name: DeleteLessonInteractionsByChunk :exec
DELETE FROM lesson_interactions WHERE chunk_id = $1;

-- name: CountLessonInteractionsByChunk :one
SELECT COUNT(*) FROM lesson_interactions WHERE chunk_id = $1;

-- name: GetLessonInteractionNextOrderIndex :one
SELECT COALESCE(MAX(order_index) + 1, 0)::int AS next_order_index
FROM lesson_interactions WHERE lesson_id = $1;

-- name: ReplaceInteraction :one
UPDATE lesson_interactions
SET kind = $2, prompt = $3, explanation = $4, config = $5, updated_at = NOW()
WHERE id = $1
RETURNING *;
