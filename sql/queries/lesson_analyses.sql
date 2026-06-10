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

-- name: ListStuckLessonAnalyses :many
-- Returns lessons whose analysis row is still in 'processing' longer
-- than the cutoff. Used by the startup sweeper to reconcile DB rows
-- whose FDB task was already reaped (worker crash, server SIGKILL,
-- etc.) and would otherwise leave the FE polling forever.
--
-- The long-running umbrella status is just 'processing'. Workflow
-- progress (transcript_extracted / chunks_ready) is stored in a
-- separate per-task table — see lesson_analysis_progress — keyed by
-- the lesson_task_id that's currently driving the work. That way
-- 'processing' here means "some AI task is in flight for this
-- lesson", and the FE can render the current step from the
-- progress table without conflating it with the umbrella state.
SELECT * FROM lesson_analyses
WHERE status = 'processing'
  AND updated_at < $1
ORDER BY updated_at ASC
LIMIT $2;

