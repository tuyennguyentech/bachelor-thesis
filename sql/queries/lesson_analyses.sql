-- name: UpsertLessonAnalysisStatus :one
INSERT INTO lesson_analyses (lesson_id, status, error_msg)
VALUES ($1, $2, $3)
ON CONFLICT (lesson_id) DO UPDATE
  SET status = EXCLUDED.status,
      error_msg = EXCLUDED.error_msg
RETURNING *;

-- name: GetLessonAnalysis :one
SELECT * FROM lesson_analyses WHERE lesson_id = $1;

-- name: UpdateLessonAnalysisStatus :exec
UPDATE lesson_analyses SET status = $2, error_msg = $3 WHERE lesson_id = $1;
