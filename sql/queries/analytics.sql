-- name: ListCourseAttemptsSummary :many
-- Returns per-student aggregate metrics for students who have at least one
-- lesson_attempt in any lesson belonging to the given course.
SELECT
  u.id                                        AS user_id,
  u.first_name,
  u.middle_name,
  u.last_name,
  u.email,
  COUNT(DISTINCT la.lesson_id)::int           AS lessons_completed,
  (
    SELECT COUNT(*)::int
    FROM lessons l2
    JOIN course_modules cm2 ON cm2.id = l2.module_id
    WHERE cm2.course_id = $1
  )                                           AS lessons_total,
  COALESCE(
    SUM(la.total_score) / NULLIF(SUM(la.max_score), 0),
    0
  )::float8                                   AS avg_score,
  COALESCE(AVG(la.video_watch_fraction), 0)::float8 AS avg_video_watch_fraction,
  COALESCE(AVG(lar_agg.avg_time_to_answer_ms), 0)::float8 AS avg_time_to_answer_ms,
  (
    COUNT(DISTINCT CASE WHEN lar_agg.response_count > 0 THEN la.lesson_id END)::float8
    / NULLIF(COUNT(DISTINCT la.lesson_id), 0)
  )::float8                                   AS response_rate,
  MAX(la.submitted_at)                        AS last_active
FROM lesson_attempts la
JOIN lessons l ON l.id = la.lesson_id
JOIN course_modules cm ON cm.id = l.module_id
JOIN users u ON u.id = la.user_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::float8                          AS response_count,
    AVG(lar.time_to_answer_ms)::float8        AS avg_time_to_answer_ms
  FROM lesson_attempt_responses lar
  WHERE lar.attempt_id = la.id
) lar_agg ON true
WHERE cm.course_id = $1
GROUP BY u.id, u.first_name, u.middle_name, u.last_name, u.email
ORDER BY last_active DESC NULLS LAST
LIMIT $2 OFFSET $3;

-- name: CountCourseAttemptStudents :one
-- Count of distinct students who have at least one attempt in the given course.
SELECT COUNT(DISTINCT la.user_id)
FROM lesson_attempts la
JOIN lessons l ON l.id = la.lesson_id
JOIN course_modules cm ON cm.id = l.module_id
WHERE cm.course_id = $1;

-- name: ListMyCourseProgress :many
-- Returns per-course aggregate metrics for the authenticated student.
-- "My courses" are courses where I have at least one lesson_attempt.
SELECT
  c.id                                        AS course_id,
  c.title,
  COUNT(DISTINCT la.lesson_id)::int           AS lessons_done,
  (
    SELECT COUNT(*)::int
    FROM lessons l2
    JOIN course_modules cm2 ON cm2.id = l2.module_id
    WHERE cm2.course_id = c.id
  )                                           AS lessons_total,
  COALESCE(
    SUM(la.total_score) / NULLIF(SUM(la.max_score), 0),
    0
  )::float8                                   AS avg_score
FROM lesson_attempts la
JOIN lessons l ON l.id = la.lesson_id
JOIN course_modules cm ON cm.id = l.module_id
JOIN courses c ON c.id = cm.course_id
WHERE la.user_id = $1
GROUP BY c.id, c.title
ORDER BY MAX(la.submitted_at) DESC NULLS LAST
LIMIT $2 OFFSET $3;
