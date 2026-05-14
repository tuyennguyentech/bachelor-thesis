-- name: UpsertLessonAnalysisStatus :one
INSERT INTO lesson_analyses (lesson_id, status, error_msg)
VALUES ($1, $2, $3)
ON CONFLICT (lesson_id) DO UPDATE
  SET status = EXCLUDED.status,
      error_msg = EXCLUDED.error_msg
RETURNING *;

-- name: GetLessonAnalysis :one
SELECT * FROM lesson_analyses WHERE lesson_id = $1;

-- name: ListLessonQuestions :many
SELECT * FROM lesson_questions
WHERE lesson_id = $1
ORDER BY order_index ASC, id ASC
LIMIT $2 OFFSET $3;

-- name: DeleteLessonQuestions :exec
DELETE FROM lesson_questions WHERE lesson_id = $1;

-- name: GetLessonQuestionByID :one
SELECT * FROM lesson_questions WHERE id = $1;

-- name: UpdateLessonQuestion :one
UPDATE lesson_questions
SET question_text = $2, options = $3, correct_answer = $4, explanation = $5, start_seconds = $6
WHERE id = $1
RETURNING *;

-- name: DeleteLessonQuestionByID :exec
DELETE FROM lesson_questions WHERE id = $1;

-- name: CreateLessonQuestion :one
INSERT INTO lesson_questions (lesson_id, question_text, options, correct_answer, explanation, order_index, start_seconds, chunk_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: UpdateLessonAnalysisStatus :exec
UPDATE lesson_analyses SET status = $2, error_msg = $3 WHERE lesson_id = $1;

-- name: GetLessonQuestionNextOrderIndex :one
SELECT COALESCE(MAX(order_index) + 1, 0)::int AS next_order_index
FROM lesson_questions
WHERE lesson_id = $1;
