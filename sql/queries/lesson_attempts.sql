-- name: UpsertLessonAttempt :one
INSERT INTO lesson_attempts (lesson_id, user_id, total_score, max_score, status, attempt_count)
VALUES ($1, $2, $3, $4, $5, 1)
ON CONFLICT (user_id, lesson_id) DO UPDATE SET
  total_score = EXCLUDED.total_score,
  max_score = EXCLUDED.max_score,
  status = EXCLUDED.status,
  attempt_count = COALESCE(lesson_attempts.attempt_count, 0) + 1,
  submitted_at = now()
RETURNING *;

-- name: GetMyLessonAttempt :one
SELECT * FROM lesson_attempts WHERE lesson_id = $1 AND user_id = $2;

-- name: DeleteLessonAttempts :exec
DELETE FROM lesson_attempts WHERE lesson_id = $1;

-- name: UpsertAttemptResponse :exec
INSERT INTO lesson_attempt_responses (attempt_id, interaction_id, response, score, max_score, feedback)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (attempt_id, interaction_id) DO UPDATE SET
  response = EXCLUDED.response,
  score = EXCLUDED.score,
  max_score = EXCLUDED.max_score,
  feedback = EXCLUDED.feedback;

-- name: ListAttemptResponses :many
SELECT lar.attempt_id, lar.interaction_id, lar.response, lar.score, lar.max_score, lar.feedback,
       li.kind AS interaction_kind
FROM lesson_attempt_responses lar
JOIN lesson_interactions li ON li.id = lar.interaction_id
WHERE lar.attempt_id = $1
ORDER BY li.order_index;

-- name: ListLessonAttempts :many
SELECT
  la.id,
  la.lesson_id,
  la.user_id,
  la.total_score,
  la.max_score,
  la.status,
  la.submitted_at,
  la.attempt_count,
  u.first_name,
  u.middle_name,
  u.last_name,
  u.email
FROM lesson_attempts la
JOIN users u ON u.id = la.user_id
WHERE la.lesson_id = $1
ORDER BY la.submitted_at DESC
LIMIT $2 OFFSET $3;

-- name: CountLessonAttempts :one
SELECT COUNT(*) FROM lesson_attempts WHERE lesson_id = $1;
