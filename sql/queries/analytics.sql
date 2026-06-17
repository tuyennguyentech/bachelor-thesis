-- name: ListCourseAttemptsSummary :many
-- Returns per-student aggregate metrics for students who have at least one
-- lesson_attempt in any lesson belonging to the given course.
--
-- response_rate = total responses submitted / total interactions available across
-- all attempted lessons.  A student who answered every question scores 1.0;
-- a student who skipped all interactions scores 0.0.
--
-- lessons_completed = distinct lessons with any attempt (course progress, the
-- same definition the student-facing ListMyCourseProgress uses).
SELECT
  u.id                                        AS user_id,
  u.first_name,
  u.middle_name,
  u.last_name,
  u.email,
  -- lessons_completed: progress = distinct lessons with any submitted attempt,
  -- regardless of score (the single progress metric — mastery/completion
  -- thresholds were removed as an unused feature).
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
  -- response_rate: interactions answered / interactions available
  -- Computes the fraction of available lesson interactions that were actually
  -- answered, averaged across all attempted lessons.  This correctly reflects
  -- whether a student engaged with the quiz content (was always 1.0 before this fix).
  COALESCE(
    SUM(lar_agg.response_count)::float8
    / NULLIF(SUM(li_agg.total_interactions), 0),
    0
  )::float8                                   AS response_rate,
  -- Raw totals for the "Tổng" results mode.
  COALESCE(SUM(la.total_score), 0)::float8    AS total_score,
  COALESCE(SUM(la.max_score), 0)::float8      AS total_max_score,
  COALESCE(SUM(lar_agg.response_count), 0)::int AS total_responses,
  COALESCE(SUM(li_agg.total_interactions), 0)::int AS total_interactions,
  COALESCE(SUM(lar_agg.total_time_ms), 0)::float8 AS total_time_ms,
  MAX(la.submitted_at)                        AS last_active
FROM lesson_attempts la
JOIN lessons l ON l.id = la.lesson_id
JOIN course_modules cm ON cm.id = l.module_id
JOIN users u ON u.id = la.user_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::float8                          AS response_count,
    AVG(lar.time_to_answer_ms)::float8        AS avg_time_to_answer_ms,
    COALESCE(SUM(lar.time_to_answer_ms), 0)::float8 AS total_time_ms
  FROM lesson_attempt_responses lar
  WHERE lar.attempt_id = la.id
) lar_agg ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::float8 AS total_interactions
  FROM lesson_interactions li
  WHERE li.lesson_id = la.lesson_id
) li_agg ON true
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

-- name: LessonChunkScoreHeatmap :many
SELECT c.id AS chunk_id, c.order_index AS chunk_index, c.start_seconds, c.end_seconds, c.summary,
  COALESCE(SUM(lar.score)::float8 / NULLIF(SUM(lar.max_score),0),0)::float8 AS avg_score,
  COUNT(lar.interaction_id)::int AS response_count,
  COUNT(DISTINCT la.user_id)::int AS student_count
FROM lesson_transcript_chunks c
LEFT JOIN lesson_interactions li ON li.chunk_id = c.id
LEFT JOIN lesson_attempt_responses lar ON lar.interaction_id = li.id
LEFT JOIN lesson_attempts la ON la.id = lar.attempt_id
WHERE c.lesson_id = $1
GROUP BY c.id, c.order_index, c.start_seconds, c.end_seconds, c.summary
ORDER BY c.order_index ASC;

-- name: ListCourseAttemptEngagementInputs :many
-- No LIMIT/OFFSET on purpose: handler scans all attempts per student to find consecutive low-engagement runs; paginate the OUTPUT in Go.
SELECT la.user_id, u.first_name, u.middle_name, u.last_name, u.email,
  l.id AS lesson_id, l.title AS lesson_title, cm.order_index AS module_order, l.order_index AS lesson_order,
  COALESCE(la.video_watch_fraction,0)::float8 AS watch_fraction,
  COALESCE(COUNT(lar.interaction_id)::float8 / NULLIF((SELECT COUNT(*) FROM lesson_interactions li WHERE li.lesson_id = la.lesson_id),0),0)::float8 AS response_rate,
  COALESCE(la.total_score / NULLIF(la.max_score,0),0)::float8 AS score_fraction,
  la.submitted_at
FROM lesson_attempts la
JOIN lessons l ON l.id = la.lesson_id
JOIN course_modules cm ON cm.id = l.module_id
JOIN users u ON u.id = la.user_id
LEFT JOIN lesson_attempt_responses lar ON lar.attempt_id = la.id
WHERE cm.course_id = $1
GROUP BY la.id, la.user_id, u.id, l.id, cm.order_index, l.order_index
ORDER BY la.user_id, cm.order_index ASC, l.order_index ASC;

-- name: LessonAccuracyByKind :many
SELECT li.kind AS kind, COUNT(*)::int AS response_count,
  COALESCE(SUM(lar.score) / NULLIF(SUM(lar.max_score),0),0)::float8 AS accuracy
FROM lesson_attempt_responses lar
JOIN lesson_attempts la ON la.id = lar.attempt_id
JOIN lesson_interactions li ON li.id = lar.interaction_id
WHERE la.lesson_id = $1
GROUP BY li.kind ORDER BY li.kind;

-- name: LessonMcqOptionDistribution :many
SELECT lar.interaction_id AS interaction_id, (lar.response->>'selected')::int AS option_index, COUNT(*)::int AS chosen_count
FROM lesson_attempt_responses lar
JOIN lesson_attempts la ON la.id = lar.attempt_id
JOIN lesson_interactions li ON li.id = lar.interaction_id
WHERE la.lesson_id = $1 AND li.kind = 'mcq' AND lar.response ? 'selected'
GROUP BY lar.interaction_id, option_index ORDER BY lar.interaction_id, option_index;

-- name: LessonQuestionStats :many
-- Per-question correctness across ALL kinds (single/multiple choice, fill, reading,
-- listening). Drives the per-question analysis so EVERY answered question shows up,
-- not just single-choice MCQ. accuracy is the score-weighted correct fraction.
SELECT lar.interaction_id AS interaction_id,
  COUNT(*)::int AS response_count,
  COALESCE(SUM(lar.score) / NULLIF(SUM(lar.max_score),0),0)::float8 AS accuracy
FROM lesson_attempt_responses lar
JOIN lesson_attempts la ON la.id = lar.attempt_id
WHERE la.lesson_id = $1
GROUP BY lar.interaction_id;

-- name: LessonChunkStudentScores :many
-- Per-(chunk, student) score for the heatmap drill-down: clicking a segment lists
-- exactly who answered that segment's questions and how they scored on it.
SELECT c.id AS chunk_id, c.order_index AS chunk_index,
  la.user_id, u.first_name, u.middle_name, u.last_name, u.email,
  COALESCE(SUM(lar.score)::float8 / NULLIF(SUM(lar.max_score),0),0)::float8 AS score_frac,
  COUNT(lar.interaction_id)::int AS answered
FROM lesson_transcript_chunks c
JOIN lesson_interactions li ON li.chunk_id = c.id
JOIN lesson_attempt_responses lar ON lar.interaction_id = li.id
JOIN lesson_attempts la ON la.id = lar.attempt_id
JOIN users u ON u.id = la.user_id
WHERE c.lesson_id = $1
GROUP BY c.id, c.order_index, la.user_id, u.id
ORDER BY c.order_index ASC, score_frac ASC;
