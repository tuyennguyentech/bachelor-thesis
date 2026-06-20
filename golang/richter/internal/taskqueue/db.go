package taskqueue

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Task is the in-memory shape of a tasks row. The wire shape is
// the sqlc-generated LessonTask struct; the queue layer works in
// its own type to keep the interface stable across schema tweaks.
type Task struct {
	ID              pgtype.UUID
	LessonID        pgtype.UUID
	ChunkID         pgtype.UUID
	TaskType        string
	Status          string
	WorkerID        pgtype.UUID
	Heartbeat       pgtype.Timestamptz
	ErrorMsg        string
	InputPayload    []byte
	OutputPayload   []byte
	QueueSeq        int64
	CreatedAt       pgtype.Timestamptz
	UpdatedAt       pgtype.Timestamptz
	StartedAt       pgtype.Timestamptz
	FinishedAt      pgtype.Timestamptz
	CreatedBy       pgtype.UUID
	ProgressStep    string
	ProgressCurrent int32
	ProgressTotal   int32
	Message         string
}

// DB is the queue's view of the tasks table. Every method
// corresponds to a single sqlc query (see sql/queries/tasks.sql).
//
// All methods are context-aware and must respect cancellation.
// Implementations should run each call in a short PG transaction
// (or use a CTEs that perform the read+update atomically) so the
// state machine stays consistent.
type DB interface {
	// CreateTask inserts a new task already 'inqueued' (the queue is
	// Postgres-only; tasks are born claimable). The input payload is
	// owned by the caller. Returns the created task.
	CreateTask(ctx context.Context, id, lessonID, chunkID, createdBy pgtype.UUID, taskType string, input []byte) (Task, error)

	// GetTask reads a task by id (no lock).
	GetTask(ctx context.Context, id pgtype.UUID) (Task, error)

	// ListTasksByLesson returns tasks for a lesson, newest first.
	ListTasksByLesson(ctx context.Context, lessonID pgtype.UUID, limit, offset int) ([]Task, error)

	// ListAllTasks returns all tasks, newest first.
	ListAllTasks(ctx context.Context, limit, offset int) ([]Task, error)

	// ListActiveTasks returns only inqueued/processing tasks, newest first.
	ListActiveTasks(ctx context.Context, limit, offset int) ([]Task, error)

	// ListLatestTaskPerLesson returns the most recent task for each
	// given lesson id, used by GetLessonAnalysis to derive analysis
	// state from the task pipeline.
	ListLatestTaskPerLesson(ctx context.Context, lessonIDs []pgtype.UUID) ([]Task, error)

	// GetActiveTask checks if there is already an inqueued/processing task.
	GetActiveTask(ctx context.Context, lessonID, chunkID pgtype.UUID, taskType string) (Task, error)

	// UpdateTaskProgress updates the task's progress fields.
	UpdateTaskProgress(ctx context.Context, id pgtype.UUID, progressStep string, progressCurrent, progressTotal int32, message string) error

	// SetTaskCheckpoint persists a mid-run partial output_payload (a resumable
	// stage checkpoint) without leaving 'processing'. Ownership-guarded by
	// workerID so a stolen task's late write is a no-op.
	SetTaskCheckpoint(ctx context.Context, id pgtype.UUID, output []byte, workerID pgtype.UUID) error

	// CountActiveTasksByUser counts active tasks for the user.
	CountActiveTasksByUser(ctx context.Context, userID pgtype.UUID) (int64, error)

	// --- Scanner primitives (recovery only) ---

	// ReapStaleProcessingBatch transitions processing tasks whose
	// heartbeat is older than staleAfter to inqueued, clearing
	// worker_id and heartbeat. Returns the rows so the scanner can
	// notify the worker pool that re-enqueue happened (for logging).
	ReapStaleProcessingBatch(ctx context.Context, batchSize int, staleAfter time.Duration) ([]Task, error)

	// RequeueOrphanedInqueuedBatch bumps inqueued tasks that have been
	// sitting too long to the head of the queue. Used as a
	// safety net for cases where the scanner's first push to a
	// downstream system (e.g. payload store) failed.
	RequeueOrphanedInqueuedBatch(ctx context.Context, batchSize int, olderThan time.Duration) ([]Task, error)

	// --- Worker primitives ---

	// ClaimNextInqueuedTask picks the next inqueued task whose task_type
	// is in taskTypes, marks it processing under workerID, sets heartbeat.
	// Returns the claimed task or no-rows (not an error).
	// Workers must pass only the task types they have executors for so that
	// workers in different packages (test vs prod) do not steal each other's
	// tasks when they share the same Postgres database.
	ClaimNextInqueuedTask(ctx context.Context, workerID pgtype.UUID, taskTypes []string) (Task, error)

	// HeartbeatTask bumps heartbeat for the (taskID, workerID) pair
	// IF the task is still processing under us. Returns rows
	// affected: 0 means stolen or cancelled.
	HeartbeatTask(ctx context.Context, taskID, workerID pgtype.UUID) (int64, error)

	// MarkSucceeded transitions processing -> succeeded and writes
	// the output payload atomically. Returns error if the row was
	// not in the expected state.
	MarkSucceeded(ctx context.Context, taskID, workerID pgtype.UUID, output []byte) error

	// MarkFailed transitions processing -> failed and stores the
	// error message. Same ownership semantics as MarkSucceeded.
	MarkFailed(ctx context.Context, taskID, workerID pgtype.UUID, errMsg string) error

	// MarkCancelled transitions any non-terminal status to
	// cancelled. Used by the user cancel RPC. Heartbeat goroutine
	// on a running task will see affected=0 on its next tick.
	MarkCancelled(ctx context.Context, taskID pgtype.UUID) error

	// ReconnectCandidates returns tasks WHERE worker_id=me AND
	// status='processing' AND heartbeat fresh. Worker startup uses
	// this to take back work that was in flight at crash time.
	ReconnectCandidates(ctx context.Context, workerID pgtype.UUID, heartbeatFreshBefore time.Time) ([]Task, error)
}
