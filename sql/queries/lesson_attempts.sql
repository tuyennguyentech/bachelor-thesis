-- name: UpsertLessonAttempt :one
INSERT INTO lesson_attempts (lesson_id, user_id, total_score, max_score, status, attempt_count, started_at, video_watch_fraction)
VALUES ($1, $2, $3, $4, $5, 1, now(), $6)
ON CONFLICT (user_id, lesson_id) DO UPDATE SET
  total_score = EXCLUDED.total_score,
  max_score = EXCLUDED.max_score,
  status = EXCLUDED.status,
  attempt_count = COALESCE(lesson_attempts.attempt_count, 0) + 1,
  submitted_at = now(),
  started_at = COALESCE(lesson_attempts.started_at, now()),
  video_watch_fraction = GREATEST(COALESCE(lesson_attempts.video_watch_fraction, 0), EXCLUDED.video_watch_fraction)
RETURNING *;

-- name: GetMyLessonAttempt :one
SELECT * FROM lesson_attempts WHERE lesson_id = $1 AND user_id = $2;

-- name: DeleteLessonAttempts :exec
DELETE FROM lesson_attempts WHERE lesson_id = $1;

-- name: UpsertAttemptResponse :exec
INSERT INTO lesson_attempt_responses (attempt_id, interaction_id, response, score, max_score, feedback, time_to_answer_ms, replay_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (attempt_id, interaction_id) DO UPDATE SET
  response = EXCLUDED.response,
  score = EXCLUDED.score,
  max_score = EXCLUDED.max_score,
  feedback = EXCLUDED.feedback,
  time_to_answer_ms = EXCLUDED.time_to_answer_ms,
  replay_count = EXCLUDED.replay_count;

-- name: ListAttemptResponses :many
SELECT lar.attempt_id, lar.interaction_id, lar.response, lar.score, lar.max_score, lar.feedback,
       lar.time_to_answer_ms, lar.replay_count,
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
  la.video_watch_fraction,
  COALESCE(AVG(lar.time_to_answer_ms), 0)::float8 AS avg_time_to_answer_ms,
  u.first_name,
  u.middle_name,
  u.last_name,
  u.email,
  -- responses submitted by this student for this attempt
  COUNT(lar.interaction_id)::int                   AS response_count,
  -- total interactions available in the lesson (for real response_rate computation)
  (SELECT COUNT(*)::int FROM lesson_interactions li WHERE li.lesson_id = la.lesson_id) AS total_interactions
FROM lesson_attempts la
JOIN users u ON u.id = la.user_id
LEFT JOIN lesson_attempt_responses lar ON lar.attempt_id = la.id
WHERE la.lesson_id = $1
GROUP BY la.id, u.id
ORDER BY la.submitted_at DESC
LIMIT $2 OFFSET $3;

-- name: CountLessonAttempts :one
SELECT COUNT(*) FROM lesson_attempts WHERE lesson_id = $1;
