-- +goose Up
CREATE TYPE task_status AS ENUM (
    'pending',
    'inqueued',
    'processing',
    'cancelled',
    'failed',
    'succeeded'
);

CREATE TABLE tasks (
    id             UUID PRIMARY KEY,
    lesson_id      UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    chunk_id       UUID,
    task_type      TEXT NOT NULL,
    status         task_status NOT NULL DEFAULT 'pending',
    worker_id      UUID,
    heartbeat      TIMESTAMPTZ,
    error_msg      TEXT,
    input_payload  BYTEA,
    output_payload BYTEA,
    queue_seq      BIGINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    created_by     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    progress_step  TEXT NOT NULL DEFAULT '',
    progress_current INT NOT NULL DEFAULT 0,
    progress_total   INT NOT NULL DEFAULT 0,
    message        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX tasks_inqueue_idx ON tasks(queue_seq) WHERE status = 'inqueued';
CREATE INDEX tasks_processing_hb_idx ON tasks(heartbeat) WHERE status = 'processing';
CREATE INDEX tasks_worker_idx ON tasks(worker_id) WHERE worker_id IS NOT NULL;
CREATE INDEX tasks_lesson_idx ON tasks(lesson_id);
CREATE INDEX tasks_created_by_active_idx ON tasks(created_by) WHERE status IN ('pending', 'inqueued', 'processing');

-- +goose Down
DROP INDEX IF EXISTS tasks_created_by_active_idx;
DROP INDEX IF EXISTS tasks_lesson_idx;
DROP INDEX IF EXISTS tasks_worker_idx;
DROP INDEX IF EXISTS tasks_processing_hb_idx;
DROP INDEX IF EXISTS tasks_inqueue_idx;
DROP TABLE IF EXISTS tasks;
DROP TYPE IF EXISTS task_status;
