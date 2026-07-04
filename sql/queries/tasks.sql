-- name: InsertTask :one
-- Births the task already 'inqueued' — the queue is Postgres-only, so there is no
-- 'pending' parking state. queue_seq is assigned inline as the next value after the
-- current inqueued tail (same semantics the old separate EnqueueTask had); the
-- AFTER INSERT trigger's pg_notify then wakes a worker that can claim it at once.
INSERT INTO tasks (
    id, lesson_id, chunk_id, task_type, status, input_payload, created_by, queue_seq
) VALUES (
    $1, $2, $3, $4, 'inqueued', $5, $6,
    (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM tasks WHERE status = 'inqueued')
)
RETURNING *;

-- name: InsertSeededTask :one
-- Inserts a synthetic task row with an EXPLICIT status — used only by seed/dev
-- paths to plant a terminal (e.g. 'succeeded') task so preflight checks pass,
-- WITHOUT enqueuing real work. queue_seq stays at its default 0; a non-'inqueued'
-- row is never claimed, so the AFTER INSERT pg_notify just wakes a worker that
-- finds nothing to do. Do NOT use this for real tasks — use InsertTask.
INSERT INTO tasks (
    id, lesson_id, chunk_id, task_type, status, input_payload, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: CountActiveTasksByUser :one
SELECT COUNT(*) FROM tasks
WHERE created_by = $1 AND status IN ('inqueued', 'processing');

-- name: GetTask :one
SELECT * FROM tasks WHERE id = $1;

-- name: GetTaskForUpdate :one
SELECT * FROM tasks WHERE id = $1 FOR UPDATE;

-- name: ListTasksByLesson :many
SELECT * FROM tasks
WHERE lesson_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListAllTasks :many
SELECT * FROM tasks
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListActiveTasks :many
SELECT * FROM tasks
WHERE status IN ('inqueued', 'processing')
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListLatestTaskPerLesson :many
-- Returns the most recent task for each (lesson, task_type),
-- useful for the GetLessonAnalysis derivation (status priority,
-- latest output per pipeline stage).
SELECT DISTINCT ON (lesson_id, task_type) *
FROM tasks
WHERE lesson_id = ANY($1::uuid[])
-- id (UUIDv7 PK) is a stable tiebreaker so the "latest" row is well-defined even
-- when two same-type re-runs share a created_at (the txn start time) — otherwise
-- DISTINCT ON returns an arbitrary, plan-dependent row and the derived analysis
-- status can flip between reloads.
ORDER BY lesson_id, task_type, created_at DESC, id DESC;

-- name: DeleteTasksForLesson :exec
-- Test helper: removes all tasks for a lesson. Tests use this
-- to reset state between subtests that share a lesson id.
DELETE FROM tasks WHERE lesson_id = $1;

-- name: DeleteTasksForLessonExcept :exec
-- A (re-)transcribe invalidates ALL downstream artifacts (chunks/interactions),
-- so it must also drop the stale downstream task rows — otherwise a leftover
-- SUCCEEDED chunk/quiz_gen/pipeline_run task keeps GetLessonAnalysis deriving
-- CHUNKS_READY/DONE. Excludes the CURRENTLY-RUNNING task so it never deletes the
-- task doing the transcribe (this is also the pipeline_run task during a pipeline).
DELETE FROM tasks WHERE lesson_id = $1 AND id <> $2;

-- name: ReapStaleProcessingBatch :many
-- Scanner primitive: processing + heartbeat stale -> inqueued.
WITH base AS (
    SELECT id, heartbeat
    FROM tasks
    WHERE status = 'processing' AND tasks.heartbeat < $2
    ORDER BY tasks.heartbeat
    FOR UPDATE SKIP LOCKED
    LIMIT $1
),
ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY heartbeat) AS rn
    FROM base
),
seq AS (
    SELECT COALESCE(MAX(queue_seq), 0) AS max_seq
    FROM tasks WHERE status = 'inqueued'
)
UPDATE tasks
SET status = 'inqueued',
    worker_id = NULL,
    heartbeat = NULL,
    queue_seq = (SELECT max_seq FROM seq) + ranked.rn,
    updated_at = now()
FROM ranked
WHERE tasks.id = ranked.id
RETURNING tasks.*;

-- name: RequeueOrphanedInqueuedBatch :many
-- Scanner primitive: inqueued rows that have been sitting too long
-- without being claimed. Bumps their queue_seq to the head so the
-- worker picks them up next.
WITH base AS (
    SELECT id, updated_at
    FROM tasks
    WHERE status = 'inqueued' AND tasks.updated_at < $2
    ORDER BY tasks.updated_at
    FOR UPDATE SKIP LOCKED
    LIMIT $1
),
ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at) AS rn
    FROM base
),
seq AS (
    SELECT COALESCE(MIN(queue_seq), 0) AS min_seq
    FROM tasks WHERE status = 'inqueued'
)
UPDATE tasks
SET queue_seq = (SELECT min_seq FROM seq) - ranked.rn,
    updated_at = now()
FROM ranked
WHERE tasks.id = ranked.id
RETURNING tasks.*;

-- name: ClaimNextInqueuedTask :one
-- Worker primitive: pick the next inqueued task whose task_type is in
-- the caller's allowlist, mark it processing under workerID, set heartbeat.
-- Returns the claimed task or no-rows.
-- The subquery + UPDATE atomic in a single statement.
UPDATE tasks
SET status = 'processing',
    worker_id = @worker_id,
    heartbeat = now(),
    started_at = COALESCE(started_at, now()),
    updated_at = now()
WHERE id = (
    SELECT id FROM tasks
    WHERE status = 'inqueued'
      AND task_type = ANY(@task_types::text[])
    ORDER BY queue_seq ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *;

-- name: HeartbeatTask :execrows
-- Worker primitive: bump heartbeat. Returns rows affected so the
-- worker can detect stolen/cancelled tasks (affected=0).
UPDATE tasks
SET heartbeat = now(), updated_at = now()
WHERE id = $1 AND worker_id = $2 AND status = 'processing';

-- name: SetTaskHeartbeat :exec
-- Set a task's heartbeat to an explicit timestamp. Used by tests to simulate a
-- stale processing task deterministically (age only THIS task) without waiting
-- out the real heartbeat timeout or racing the global scanner.
UPDATE tasks
SET heartbeat = $2
WHERE id = $1;

-- name: MarkSucceeded :exec
-- Worker primitive: terminal success transition. Sets output_payload
-- atomically with status. The WHERE clause ensures we only commit
-- a terminal write for tasks we still own.
UPDATE tasks
SET status = 'succeeded',
    output_payload = $2,
    finished_at = now(),
    updated_at = now(),
    heartbeat = NULL,
    worker_id = NULL,
    message = ''
WHERE id = $1 AND worker_id = $3 AND status = 'processing';

-- name: MarkFailed :exec
UPDATE tasks
SET status = 'failed',
    error_msg = $2,
    finished_at = now(),
    updated_at = now(),
    heartbeat = NULL,
    worker_id = NULL,
    message = ''
WHERE id = $1 AND worker_id = $3 AND status = 'processing';

-- name: CancelTask :exec
-- User cancel RPC. Transitions from any non-terminal status to
-- cancelled. Heartbeat goroutine on a running task will see
-- affected=0 on its next tick and cancel the local goroutine.
UPDATE tasks
SET status = 'cancelled',
    finished_at = now(),
    updated_at = now(),
    worker_id = NULL,
    heartbeat = NULL,
    message = ''
WHERE id = $1
  AND status IN ('inqueued', 'processing');

-- name: ReconnectCandidates :many
-- Worker primitive: on startup, find tasks still under our worker_id
-- whose heartbeat is fresh enough to be ours (i.e. we just restarted
-- and want to take them back).
SELECT * FROM tasks
WHERE worker_id = $1
  AND status = 'processing'
  AND heartbeat > $2;

-- name: GetActiveTask :one
SELECT * FROM tasks
WHERE lesson_id = @lesson_id::uuid
  AND task_type = @task_type
  AND (
    (chunk_id IS NULL AND @chunk_id::uuid IS NULL) OR
    (chunk_id = @chunk_id::uuid)
  )
  AND status IN ('inqueued', 'processing')
LIMIT 1;

-- name: UpdateTaskProgress :exec
UPDATE tasks
SET progress_step = $2,
    progress_current = $3,
    progress_total = $4,
    message = $5,
    updated_at = now()
WHERE id = $1;

-- name: SetTaskCheckpoint :exec
-- Worker primitive: persist a mid-run checkpoint (partial output_payload)
-- WITHOUT leaving 'processing', so a crash + reclaim can resume from the last
-- completed stage instead of restarting the whole pipeline. The ownership
-- clause mirrors MarkSucceeded so a stolen task's late checkpoint is a no-op.
UPDATE tasks
SET output_payload = $2,
    updated_at = now()
WHERE id = $1 AND worker_id = $3 AND status = 'processing';

-- name: CountTaskStatusBuckets :one
-- System-wide task counts grouped into the three buckets the admin monitor
-- displays. A single round-trip replaces three separate COUNT(*) queries.
SELECT
  count(*) FILTER (WHERE status IN ('inqueued', 'processing')) AS active,
  count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
  count(*) FILTER (WHERE status IN ('failed', 'cancelled')) AS failed_or_cancelled
FROM tasks;
