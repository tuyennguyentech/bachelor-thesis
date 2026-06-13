-- name: CreateJoinRequest :one
INSERT INTO course_join_requests (course_id, user_id, status, requested_role)
VALUES ($1, $2, 'pending', $3)
ON CONFLICT (course_id, user_id) DO UPDATE
  SET status = 'pending',
      requested_role = EXCLUDED.requested_role,
      updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
RETURNING *;

-- name: ReviewJoinRequest :one
UPDATE course_join_requests
SET status = $3,
    updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
WHERE course_id = $1 AND user_id = $2
RETURNING *;

-- name: GetJoinRequest :one
SELECT *
FROM course_join_requests
WHERE course_id = $1 AND user_id = $2;

-- name: ListPendingJoinRequests :many
SELECT
  cjr.*,
  u.email      AS user_email,
  u.first_name AS user_first_name,
  u.last_name  AS user_last_name
FROM course_join_requests cjr
JOIN users u ON u.id = cjr.user_id
WHERE cjr.course_id = $1 AND cjr.status = 'pending'
ORDER BY cjr.created_at ASC
LIMIT $2 OFFSET $3;
