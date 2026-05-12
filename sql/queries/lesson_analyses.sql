-- name: UpsertLessonAnalysis :one
INSERT INTO lesson_analyses (lesson_id, status, transcript, error_msg)
VALUES ($1, $2, $3, $4)
ON CONFLICT (lesson_id) DO UPDATE
  SET status = EXCLUDED.status,
      transcript = EXCLUDED.transcript,
      error_msg = EXCLUDED.error_msg
RETURNING *;

-- name: GetLessonAnalysis :one
SELECT * FROM lesson_analyses WHERE lesson_id = $1;

-- name: ListLessonQuestions :many
SELECT * FROM lesson_questions
WHERE lesson_id = $1
ORDER BY order_index ASC, id ASC;

-- name: DeleteLessonQuestions :exec
DELETE FROM lesson_questions WHERE lesson_id = $1;

-- name: CreateLessonQuestion :one
INSERT INTO lesson_questions (lesson_id, question_text, options, correct_answer, explanation, order_index)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;
