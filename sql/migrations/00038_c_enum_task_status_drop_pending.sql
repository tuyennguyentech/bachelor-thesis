-- +goose Up
-- 'pending' was a FoundationDB-era queue state. The queue is Postgres-only now and
-- tasks are born 'inqueued' (StartLessonTask inserts them already queued), so the
-- 'pending' value is removed from task_status. Postgres has no ALTER TYPE ... DROP
-- VALUE, so the enum is recreated: rename old -> create new -> cast column -> drop old.
UPDATE tasks SET status = 'inqueued' WHERE status = 'pending';

ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;

-- ALL partial indexes whose predicate references status must be dropped before the
-- type swap: once task_status is renamed to task_status_old, their stored enum
-- literals are typed task_status_old and won't compare against the new column type
-- during the rewrite (operator does not exist: task_status = task_status_old).
-- They are recreated after the swap (tasks_created_by_active_idx loses 'pending').
DROP INDEX tasks_inqueue_idx;
DROP INDEX tasks_processing_hb_idx;
DROP INDEX tasks_created_by_active_idx;

ALTER TYPE task_status RENAME TO task_status_old;
CREATE TYPE task_status AS ENUM (
    'inqueued',
    'processing',
    'cancelled',
    'failed',
    'succeeded'
);
ALTER TABLE tasks
    ALTER COLUMN status TYPE task_status USING status::text::task_status;
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'inqueued';
DROP TYPE task_status_old;

CREATE INDEX tasks_inqueue_idx ON tasks(queue_seq) WHERE status = 'inqueued';
CREATE INDEX tasks_processing_hb_idx ON tasks(heartbeat) WHERE status = 'processing';
CREATE INDEX tasks_created_by_active_idx ON tasks(created_by)
    WHERE status IN ('inqueued', 'processing');

-- +goose Down
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
DROP INDEX tasks_inqueue_idx;
DROP INDEX tasks_processing_hb_idx;
DROP INDEX tasks_created_by_active_idx;

ALTER TYPE task_status RENAME TO task_status_new;
CREATE TYPE task_status AS ENUM (
    'pending',
    'inqueued',
    'processing',
    'cancelled',
    'failed',
    'succeeded'
);
ALTER TABLE tasks
    ALTER COLUMN status TYPE task_status USING status::text::task_status;
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'pending';
DROP TYPE task_status_new;

CREATE INDEX tasks_inqueue_idx ON tasks(queue_seq) WHERE status = 'inqueued';
CREATE INDEX tasks_processing_hb_idx ON tasks(heartbeat) WHERE status = 'processing';
CREATE INDEX tasks_created_by_active_idx ON tasks(created_by)
    WHERE status IN ('pending', 'inqueued', 'processing');
