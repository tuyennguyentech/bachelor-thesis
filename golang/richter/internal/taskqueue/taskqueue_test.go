//go:build integ

package taskqueue

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

type testExecutor struct {
	executeFunc func(ctx context.Context, env *Env) ([]byte, error)
}

func (t *testExecutor) Kind() string { return "test_task" }
func (t *testExecutor) Execute(ctx context.Context, env *Env) ([]byte, error) {
	if t.executeFunc != nil {
		return t.executeFunc(ctx, env)
	}
	return []byte("test-success"), nil
}

var registerOnce sync.Once

func setupTestRegistry(fn func(ctx context.Context, env *Env) ([]byte, error)) {
	registerOnce.Do(func() {
		Register("test_task", func() Executor {
			return &testExecutor{executeFunc: fn}
		})
	})
}

func getOrCreateTestUserAndLesson(t *testing.T, pool *db.PostgresSvc) (pgtype.UUID, pgtype.UUID) {
	ctx := context.Background()
	var userID pgtype.UUID
	var lessonID pgtype.UUID

	err := db.WithConnectionExec(pool, ctx, func(q *gen.Queries, conn *pgxpool.Conn) error {
		if err := conn.QueryRow(ctx, "SELECT id FROM users LIMIT 1").Scan(&userID); err != nil {
			return err
		}
		if err := conn.QueryRow(ctx, "SELECT id FROM lessons LIMIT 1").Scan(&lessonID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatalf("failed to setup test user/lesson: %v", err)
	}
	return userID, lessonID
}

func clearAllTasks(t *testing.T, pool *db.PostgresSvc) {
	t.Helper()
	err := db.WithConnectionExec(pool, context.Background(), func(q *gen.Queries, conn *pgxpool.Conn) error {
		_, err := conn.Exec(context.Background(), "DELETE FROM tasks")
		return err
	})
	if err != nil {
		t.Fatalf("failed to clear tasks table: %v", err)
	}
}

func TestPostgresDB_TaskLifecycle(t *testing.T) {
	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx := context.Background()
	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}

	// 1. CreateTask
	task, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_task", []byte("hello"))
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if task.Status != string(StatusPending) {
		t.Errorf("expected task status to be pending, got %s", task.Status)
	}

	// 2. EnqueuePendingBatch
	enqueued, err := tq.EnqueuePendingBatch(ctx, 10)
	if err != nil {
		t.Fatalf("EnqueuePendingBatch: %v", err)
	}
	found := false
	for _, tk := range enqueued {
		if tk.ID == taskID {
			found = true
			if tk.Status != string(StatusInqueued) {
				t.Errorf("expected status to be inqueued, got %s", tk.Status)
			}
		}
	}
	if !found {
		t.Errorf("task not found in enqueued batch")
	}

	// 3. ClaimNextInqueuedTask
	workerIDRaw, _ := uuid.NewV7()
	workerID := pgtype.UUID{Bytes: [16]byte(workerIDRaw), Valid: true}
	claimed, err := tq.ClaimNextInqueuedTask(ctx, workerID)
	if err != nil {
		t.Fatalf("ClaimNextInqueuedTask: %v", err)
	}
	if claimed.ID != taskID {
		t.Fatalf("expected to claim task %v, got %v", taskID, claimed.ID)
	}
	if claimed.Status != string(StatusProcessing) {
		t.Errorf("expected claimed task status to be processing, got %s", claimed.Status)
	}

	// 4. HeartbeatTask
	rows, err := tq.HeartbeatTask(ctx, taskID, workerID)
	if err != nil {
		t.Fatalf("HeartbeatTask: %v", err)
	}
	if rows != 1 {
		t.Errorf("expected 1 row affected by heartbeat, got %d", rows)
	}

	// 5. MarkSucceeded
	err = tq.MarkSucceeded(ctx, taskID, workerID, []byte("output"))
	if err != nil {
		t.Fatalf("MarkSucceeded: %v", err)
	}

	// Verify terminal state
	finalTask, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatalf("GetTask: %v", err)
	}
	if finalTask.Status != string(StatusSucceeded) {
		t.Errorf("expected status to be succeeded, got %s", finalTask.Status)
	}
	if string(finalTask.OutputPayload) != "output" {
		t.Errorf("expected output_payload to be 'output', got %s", string(finalTask.OutputPayload))
	}
}

func TestPostgresDB_ReapStaleProcessing(t *testing.T) {
	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx := context.Background()
	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}

	// Create a task
	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_task", nil)
	if err != nil {
		t.Fatal(err)
	}

	workerIDRaw, _ := uuid.NewV7()
	workerID := pgtype.UUID{Bytes: [16]byte(workerIDRaw), Valid: true}

	// Manually set status to processing, worker_id, and backdate the heartbeat
	err = db.WithConnectionExec(pool, ctx, func(q *gen.Queries, conn *pgxpool.Conn) error {
		_, err := conn.Exec(ctx, `
			UPDATE tasks
			SET status = 'processing', worker_id = $2, heartbeat = $3
			WHERE id = $1`,
			taskID, workerID, time.Now().UTC().Add(-2*time.Hour))
		return err
	})
	if err != nil {
		t.Fatalf("failed to backdate heartbeat: %v", err)
	}

	// Reap stale task
	reaped, err := tq.ReapStaleProcessingBatch(ctx, 10, 1*time.Hour)
	if err != nil {
		t.Fatalf("ReapStaleProcessingBatch: %v", err)
	}
	found := false
	for _, tk := range reaped {
		if tk.ID == taskID {
			found = true
			if tk.Status != string(StatusInqueued) {
				t.Errorf("expected status after reap to be inqueued, got %s", tk.Status)
			}
			if tk.WorkerID.Valid {
				t.Errorf("expected worker_id to be cleared after reap")
			}
		}
	}
	if !found {
		t.Errorf("task was not reaped")
	}
}

func TestPostgresDB_CancelTask(t *testing.T) {
	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx := context.Background()
	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}

	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_task", nil)
	if err != nil {
		t.Fatal(err)
	}

	err = tq.MarkCancelled(ctx, taskID)
	if err != nil {
		t.Fatalf("MarkCancelled: %v", err)
	}

	task, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusCancelled) {
		t.Errorf("expected status to be cancelled, got %s", task.Status)
	}
}

func TestTaskqueue_WorkerLifecycle(t *testing.T) {
	setupTestRegistry(func(ctx context.Context, env *Env) ([]byte, error) {
		return []byte("worker-lifecycle-success"), nil
	})

	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. Create a scanner with 100ms interval for fast testing
	logger := slog.Default()
	scanner := NewScannerRaw(tq, logger).WithInterval(100 * time.Millisecond).WithStaleAfter(1 * time.Second)

	// 2. Create worker
	worker := NewWorkerRaw(tq, logger, scanner.NotifCh())
	worker.heartbeat = 100 * time.Millisecond
	worker.pollIdle = 100 * time.Millisecond

	// Start scanner and worker in background
	go scanner.Run(ctx)
	go worker.Run(ctx)

	// 3. Create a task
	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}
	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_task", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}

	// 4. Wait for it to be processed and completed
	// We poll the status for up to 3 seconds
	start := time.Now()
	for time.Since(start) < 3*time.Second {
		task, err := tq.GetTask(ctx, taskID)
		if err != nil {
			t.Fatal(err)
		}
		if task.Status == string(StatusSucceeded) {
			if string(task.OutputPayload) != "worker-lifecycle-success" {
				t.Errorf("expected output payload to be 'worker-lifecycle-success', got %s", string(task.OutputPayload))
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("task was not processed by worker in time")
}

var (
	recoveryRunCount int
	recoveryRunMutex sync.Mutex
	recoveryBlocked  = make(chan struct{})
)

var registerRecoveryOnce sync.Once

func setupRecoveryRegistry() {
	registerRecoveryOnce.Do(func() {
		Register("test_recovery_task", func() Executor {
			return &testExecutor{
				executeFunc: func(ctx context.Context, env *Env) ([]byte, error) {
					recoveryRunMutex.Lock()
					recoveryRunCount++
					count := recoveryRunCount
					recoveryRunMutex.Unlock()

					if count == 1 {
						close(recoveryBlocked)
						<-ctx.Done()
						return nil, ctx.Err()
					}
					return []byte("recovery-success"), nil
				},
			}
		})
	})
}

func TestTaskqueue_WorkerCrashAndRecovery(t *testing.T) {
	setupRecoveryRegistry()

	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()

	logger := slog.Default()
	scanner := NewScannerRaw(tq, logger).WithInterval(100 * time.Millisecond).WithStaleAfter(100 * time.Millisecond)

	worker1 := NewWorkerRaw(tq, logger, scanner.NotifCh())
	worker1.heartbeat = 50 * time.Millisecond
	worker1.pollIdle = 50 * time.Millisecond

	go scanner.Run(ctx1)
	go worker1.Run(ctx1)

	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}
	_, err := tq.CreateTask(ctx1, taskID, lessonID, pgtype.UUID{}, userID, "test_recovery_task", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-recoveryBlocked:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker 1 to claim and run task")
	}

	task, err := tq.GetTask(ctx1, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusProcessing) {
		t.Fatalf("expected task status to be processing, got %s", task.Status)
	}
	if !task.WorkerID.Valid || task.WorkerID.Bytes == [16]byte{} {
		t.Fatal("expected task to have a valid worker_id")
	}

	cancel1()

	err = db.WithConnectionExec(pool, context.Background(), func(q *gen.Queries, conn *pgxpool.Conn) error {
		_, err := conn.Exec(context.Background(), `
			UPDATE tasks
			SET heartbeat = $2
			WHERE id = $1`,
			taskID, time.Now().UTC().Add(-10*time.Second))
		return err
	})
	if err != nil {
		t.Fatalf("failed to backdate heartbeat: %v", err)
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()

	scanner2 := NewScannerRaw(tq, logger).WithInterval(50 * time.Millisecond).WithStaleAfter(100 * time.Millisecond)
	worker2 := NewWorkerRaw(tq, logger, scanner2.NotifCh())
	worker2.heartbeat = 50 * time.Millisecond
	worker2.pollIdle = 50 * time.Millisecond

	go scanner2.Run(ctx2)
	go worker2.Run(ctx2)

	start := time.Now()
	for time.Since(start) < 5*time.Second {
		task, err := tq.GetTask(ctx2, taskID)
		if err != nil {
			t.Fatal(err)
		}
		if task.Status == string(StatusSucceeded) {
			if string(task.OutputPayload) != "recovery-success" {
				t.Errorf("expected output payload to be 'recovery-success', got %s", string(task.OutputPayload))
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("task was not recovered and processed by worker 2 in time")
}

