-- name: UpsertQuizAttempt :one
INSERT INTO quiz_attempts (lesson_id, user_id, answers, score, total)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (lesson_id, user_id) DO UPDATE SET
  answers = EXCLUDED.answers,
  score = EXCLUDED.score,
  total = EXCLUDED.total,
  submitted_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
RETURNING *;

-- name: GetMyQuizAttempt :one
SELECT * FROM quiz_attempts WHERE lesson_id = $1 AND user_id = $2 LIMIT 1;

-- name: ListLessonAttempts :many
SELECT
  qa.id,
  qa.lesson_id,
  qa.user_id,
  qa.answers,
  qa.score,
  qa.total,
  qa.submitted_at,
  u.first_name,
  u.middle_name,
  u.last_name,
  u.email
FROM quiz_attempts qa
JOIN users u ON u.id = qa.user_id
WHERE qa.lesson_id = $1
ORDER BY qa.submitted_at DESC
LIMIT $2 OFFSET $3;

-- name: CountLessonAttempts :one
SELECT COUNT(*) FROM quiz_attempts WHERE lesson_id = $1;

-- name: DeleteLessonAttempts :exec
DELETE FROM quiz_attempts WHERE lesson_id = $1;
