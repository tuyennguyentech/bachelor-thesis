package taskqueue

import (
	"context"
	"errors"
	"fmt"
	"time"

	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

// PostgresDB is the production implementation of DB. It wraps a
// pgxpool.Pool and translates the sqlc-generated row shape to the
// queue's Task type. The queue layer doesn't import gen/sql — only
// this adapter does.
type PostgresDB struct {
	pool *db.PostgresSvc
}

// NewPostgresDB returns a DB backed by the given connection pool.
func NewPostgresDB(pool *db.PostgresSvc) *PostgresDB {
	return &PostgresDB{pool: pool}
}

// NewDB is the do.Injector factory: resolves PostgresSvc and returns
// a DB interface ready to use. Returns the interface so callers
// don't bind to the concrete PostgresDB type.
func NewDB(i do.Injector) (DB, error) {
	pool, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewDB: PostgresSvc: %w", err)
	}
	return NewPostgresDB(pool), nil
}

// FromGen converts a sqlc-generated task row to the queue's Task.
// Exported so callers outside the taskqueue package can convert
// gen.Task -> taskqueue.Task without duplicating the mapping.
func FromGen(t gen.Task) Task {
	return Task{
		ID:              t.ID,
		LessonID:        t.LessonID,
		ChunkID:         t.ChunkID,
		TaskType:        t.TaskType,
		Status:          string(t.Status),
		WorkerID:        t.WorkerID,
		Heartbeat:       t.Heartbeat,
		ErrorMsg:        t.ErrorMsg.String,
		InputPayload:    t.InputPayload,
		OutputPayload:   t.OutputPayload,
		QueueSeq:        t.QueueSeq,
		CreatedAt:       t.CreatedAt,
		UpdatedAt:       t.UpdatedAt,
		StartedAt:       t.StartedAt,
		FinishedAt:      t.FinishedAt,
		CreatedBy:       t.CreatedBy,
		ProgressStep:    t.ProgressStep,
		ProgressCurrent: t.ProgressCurrent,
		ProgressTotal:   t.ProgressTotal,
		Message:         t.Message,
	}
}

// Status constants — string aliases for the gen.TaskStatus enum so
// callers don't have to import the sqlc package. The strings match
// the migration enum labels exactly.
const (
	StatusPending    = gen.TaskStatusPending
	StatusInqueued   = gen.TaskStatusInqueued
	StatusProcessing = gen.TaskStatusProcessing
	StatusSucceeded  = gen.TaskStatusSucceeded
	StatusFailed     = gen.TaskStatusFailed
	StatusCancelled  = gen.TaskStatusCancelled
)

func (p *PostgresDB) CreateTask(ctx context.Context, id, lessonID, chunkID, createdBy pgtype.UUID, taskType string, input []byte) (Task, error) {
	row, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Task, error) {
		return q.InsertTask(ctx, gen.InsertTaskParams{
			ID:           id,
			LessonID:     lessonID,
			ChunkID:      chunkID,
			TaskType:     taskType,
			Status:       gen.TaskStatusPending,
			InputPayload: input,
			CreatedBy:    createdBy,
		})
	})
	if err != nil {
		return Task{}, err
	}
	return FromGen(row), nil
}

func (p *PostgresDB) GetTask(ctx context.Context, id pgtype.UUID) (Task, error) {
	row, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Task, error) {
		return q.GetTask(ctx, id)
	})
	if err != nil {
		return Task{}, err
	}
	return FromGen(row), nil
}

func (p *PostgresDB) ListTasksByLesson(ctx context.Context, lessonID pgtype.UUID, limit, offset int) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.ListTasksByLesson(ctx, gen.ListTasksByLessonParams{
			LessonID: lessonID,
			Limit:    int32(limit),
			Offset:   int32(offset),
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) ListAllTasks(ctx context.Context, limit, offset int) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.ListAllTasks(ctx, gen.ListAllTasksParams{
			Limit:  int32(limit),
			Offset: int32(offset),
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) ListActiveTasks(ctx context.Context, limit, offset int) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.ListActiveTasks(ctx, gen.ListActiveTasksParams{
			Limit:  int32(limit),
			Offset: int32(offset),
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) ListLatestTaskPerLesson(ctx context.Context, lessonIDs []pgtype.UUID) ([]Task, error) {
	if len(lessonIDs) == 0 {
		return nil, nil
	}
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.ListLatestTaskPerLesson(ctx, lessonIDs)
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) EnqueuePendingBatch(ctx context.Context, batchSize int) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.EnqueuePendingBatch(ctx, int32(batchSize))
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) ReapStaleProcessingBatch(ctx context.Context, batchSize int, staleAfter time.Duration) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.ReapStaleProcessingBatch(ctx, gen.ReapStaleProcessingBatchParams{
			Limit:     int32(batchSize),
			Heartbeat: pgtype.Timestamptz{Time: time.Now().UTC().Add(-staleAfter), Valid: true},
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) RequeueOrphanedInqueuedBatch(ctx context.Context, batchSize int, olderThan time.Duration) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.RequeueOrphanedInqueuedBatch(ctx, gen.RequeueOrphanedInqueuedBatchParams{
			Limit:     int32(batchSize),
			UpdatedAt: pgtype.Timestamptz{Time: time.Now().UTC().Add(-olderThan), Valid: true},
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) ClaimNextInqueuedTask(ctx context.Context, workerID pgtype.UUID, taskTypes []string) (Task, error) {
	row, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Task, error) {
		return q.ClaimNextInqueuedTask(ctx, gen.ClaimNextInqueuedTaskParams{
			WorkerID:  workerID,
			TaskTypes: taskTypes,
		})
	})
	if err != nil {
		return Task{}, err
	}
	return FromGen(row), nil
}

func (p *PostgresDB) HeartbeatTask(ctx context.Context, taskID, workerID pgtype.UUID) (int64, error) {
	// The HeartbeatTask :execrows query returns rows affected so the worker
	// can detect a stolen/cancelled task (affected=0).
	n, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.HeartbeatTask(ctx, gen.HeartbeatTaskParams{ID: taskID, WorkerID: workerID})
	})
	if err != nil {
		return 0, fmt.Errorf("taskqueue: heartbeat: %w", err)
	}
	return n, nil
}

func (p *PostgresDB) MarkSucceeded(ctx context.Context, taskID, workerID pgtype.UUID, output []byte) error {
	// Inherit the WithConnectionExec pattern but read the error
	// returned by sqlc which is already ErrNoRows if no row matched.
	if err := db.WithConnectionExec(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.MarkSucceeded(ctx, gen.MarkSucceededParams{
			ID:            taskID,
			WorkerID:      workerID,
			OutputPayload: output,
		})
	}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

func (p *PostgresDB) MarkFailed(ctx context.Context, taskID, workerID pgtype.UUID, errMsg string) error {
	if err := db.WithConnectionExec(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.MarkFailed(ctx, gen.MarkFailedParams{
			ID:       taskID,
			WorkerID: workerID,
			ErrorMsg: pgtype.Text{String: errMsg, Valid: true},
		})
	}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

func (p *PostgresDB) MarkCancelled(ctx context.Context, taskID pgtype.UUID) error {
	return db.WithConnectionExec(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.CancelTask(ctx, taskID)
	})
}

func (p *PostgresDB) ReconnectCandidates(ctx context.Context, workerID pgtype.UUID, heartbeatFreshBefore time.Time) ([]Task, error) {
	rows, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
		return q.ReconnectCandidates(ctx, gen.ReconnectCandidatesParams{
			WorkerID:  workerID,
			Heartbeat: pgtype.Timestamptz{Time: heartbeatFreshBefore, Valid: true},
		})
	})
	if err != nil {
		return nil, err
	}
	out := make([]Task, len(rows))
	for i, r := range rows {
		out[i] = FromGen(r)
	}
	return out, nil
}

func (p *PostgresDB) GetActiveTask(ctx context.Context, lessonID, chunkID pgtype.UUID, taskType string) (Task, error) {
	row, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Task, error) {
		return q.GetActiveTask(ctx, gen.GetActiveTaskParams{
			LessonID: lessonID,
			ChunkID:  chunkID,
			TaskType: taskType,
		})
	})
	if err != nil {
		return Task{}, err
	}
	return FromGen(row), nil
}

func (p *PostgresDB) UpdateTaskProgress(ctx context.Context, id pgtype.UUID, progressStep string, progressCurrent, progressTotal int32, message string) error {
	return db.WithConnectionExec(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.UpdateTaskProgress(ctx, gen.UpdateTaskProgressParams{
			ID:              id,
			ProgressStep:    progressStep,
			ProgressCurrent: progressCurrent,
			ProgressTotal:   progressTotal,
			Message:         message,
		})
	})
}

func (p *PostgresDB) SetTaskCheckpoint(ctx context.Context, id pgtype.UUID, output []byte, workerID pgtype.UUID) error {
	return db.WithConnectionExec(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.SetTaskCheckpoint(ctx, gen.SetTaskCheckpointParams{
			ID:            id,
			OutputPayload: output,
			WorkerID:      workerID,
		})
	})
}

func (p *PostgresDB) CountActiveTasksByUser(ctx context.Context, userID pgtype.UUID) (int64, error) {
	row, err := db.WithConnection(p.pool, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.CountActiveTasksByUser(ctx, userID)
	})
	if err != nil {
		return 0, err
	}
	return row, nil
}
