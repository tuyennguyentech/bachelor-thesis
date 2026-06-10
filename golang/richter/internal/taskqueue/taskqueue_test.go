//go:build integ

package taskqueue

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

var (
	activeControlledExecMutex sync.Mutex
	activeControlledExec      *controlledExecutor
)

type controlledExecutor struct {
	started chan struct{}
	release chan struct{}
	done    chan struct{}
	err     error
	output  []byte
}

func (e *controlledExecutor) Kind() string { return "controlled_task" }
func (e *controlledExecutor) Execute(ctx context.Context, env *Env) ([]byte, error) {
	close(e.started)
	select {
	case <-e.release:
		close(e.done)
		return e.output, e.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

var registerOnce sync.Once

func setupTestRegistry(fn func(ctx context.Context, env *Env) ([]byte, error)) {
	registerOnce.Do(func() {
		Register("test_task", func() Executor {
			return &testExecutor{executeFunc: fn}
		})
		Register("controlled_task", func() Executor {
			activeControlledExecMutex.Lock()
			defer activeControlledExecMutex.Unlock()
			return activeControlledExec
		})
	})
}

type runGroup struct {
	wg     sync.WaitGroup
	ctx    context.Context
	cancel context.CancelFunc
}

func newRunGroup(parent context.Context) *runGroup {
	ctx, cancel := context.WithCancel(parent)
	return &runGroup{
		ctx:    ctx,
		cancel: cancel,
	}
}

func (rg *runGroup) StartWorker(w *Worker) {
	rg.wg.Add(1)
	go func() {
		defer rg.wg.Done()
		w.Run(rg.ctx)
	}()
}

func (rg *runGroup) StartScanner(s *Scanner) {
	rg.wg.Add(1)
	go func() {
		defer rg.wg.Done()
		s.Run(rg.ctx)
	}()
}

func (rg *runGroup) Close() {
	rg.cancel()
	rg.wg.Wait()
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

var (
	stealBlocked  = make(chan struct{})
	cancelBlocked = make(chan struct{})
)

var registerStealOnce sync.Once

func setupStealRegistry() {
	registerStealOnce.Do(func() {
		Register("test_steal_task", func() Executor {
			return &testExecutor{
				executeFunc: func(ctx context.Context, env *Env) ([]byte, error) {
					close(stealBlocked)
					<-ctx.Done()
					return nil, ctx.Err()
				},
			}
		})
	})
}

var registerCancelOnce sync.Once

func setupCancelRegistry() {
	registerCancelOnce.Do(func() {
		Register("test_cancel_task", func() Executor {
			return &testExecutor{
				executeFunc: func(ctx context.Context, env *Env) ([]byte, error) {
					close(cancelBlocked)
					<-ctx.Done()
					return nil, ctx.Err()
				},
			}
		})
	})
}

func TestTaskqueue_WorkerHeartbeatSteal(t *testing.T) {
	setupStealRegistry()

	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := slog.Default()
	scanner := NewScannerRaw(tq, logger).WithInterval(100 * time.Millisecond).WithStaleAfter(1 * time.Second)

	worker := NewWorkerRaw(tq, logger, scanner.NotifCh())
	worker.heartbeat = 50 * time.Millisecond
	worker.pollIdle = 50 * time.Millisecond

	go scanner.Run(ctx)
	go worker.Run(ctx)

	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}
	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_steal_task", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-stealBlocked:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker to claim task")
	}

	otherWorkerIDRaw, _ := uuid.NewV7()
	otherWorkerID := pgtype.UUID{Bytes: [16]byte(otherWorkerIDRaw), Valid: true}
	err = db.WithConnectionExec(pool, context.Background(), func(q *gen.Queries, conn *pgxpool.Conn) error {
		_, err := conn.Exec(context.Background(), `
			UPDATE tasks
			SET worker_id = $2
			WHERE id = $1`,
			taskID, otherWorkerID)
		return err
	})
	if err != nil {
		t.Fatalf("failed to update worker_id: %v", err)
	}

	time.Sleep(200 * time.Millisecond)

	task, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}

	if task.Status != string(StatusProcessing) {
		t.Errorf("expected task status to remain processing, got %s", task.Status)
	}
	if task.WorkerID.Bytes != otherWorkerID.Bytes {
		t.Errorf("expected worker_id to remain otherWorkerID, got %s", task.WorkerID.String())
	}
}

func TestTaskqueue_WorkerCancelPropagation(t *testing.T) {
	setupCancelRegistry()

	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := slog.Default()
	scanner := NewScannerRaw(tq, logger).WithInterval(100 * time.Millisecond).WithStaleAfter(1 * time.Second)

	worker := NewWorkerRaw(tq, logger, scanner.NotifCh())
	worker.heartbeat = 50 * time.Millisecond
	worker.pollIdle = 50 * time.Millisecond

	go scanner.Run(ctx)
	go worker.Run(ctx)

	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}
	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_cancel_task", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-cancelBlocked:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker to claim task")
	}

	err = tq.MarkCancelled(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(200 * time.Millisecond)

	task, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusCancelled) {
		t.Errorf("expected task status to be cancelled, got %s", task.Status)
	}
}

func TestPostgresDB_OptimisticConcurrency(t *testing.T) {
	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	ctx := context.Background()
	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}

	// 1. Tạo task (pending)
	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "test_task", nil)
	if err != nil {
		t.Fatal(err)
	}

	// Đẩy sang inqueued
	_, err = tq.EnqueuePendingBatch(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}

	workerID1Raw, _ := uuid.NewV7()
	workerID1 := pgtype.UUID{Bytes: [16]byte(workerID1Raw), Valid: true}

	// Worker 1 claim -> status=processing, worker_id=workerID1
	_, err = tq.ClaimNextInqueuedTask(ctx, workerID1)
	if err != nil {
		t.Fatal(err)
	}

	// --- Case 1b: Scanner đã reap đưa về inqueued, worker_id = NULL ---
	err = db.WithConnectionExec(pool, ctx, func(q *gen.Queries, conn *pgxpool.Conn) error {
		_, err := conn.Exec(ctx, `
			UPDATE tasks
			SET status = 'inqueued', worker_id = NULL, heartbeat = NULL
			WHERE id = $1`,
			taskID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	// Worker 1 thức dậy cố gắng hoàn thành task thành công
	err = tq.MarkSucceeded(ctx, taskID, workerID1, []byte("out1"))
	if err != nil {
		t.Errorf("MarkSucceeded should not return error, got %v", err)
	}

	// Kiểm tra: trạng thái task phải giữ nguyên là 'inqueued', worker_id phải là NULL (không bị Worker 1 ghi đè)
	task, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusInqueued) {
		t.Errorf("expected status to remain inqueued, got %s", task.Status)
	}
	if task.WorkerID.Valid {
		t.Errorf("expected worker_id to remain NULL, got %s", task.WorkerID.String())
	}

	// --- Case 2: Worker 2 đã claim -> status=processing, worker_id=workerID2 ---
	workerID2Raw, _ := uuid.NewV7()
	workerID2 := pgtype.UUID{Bytes: [16]byte(workerID2Raw), Valid: true}
	_, err = tq.ClaimNextInqueuedTask(ctx, workerID2)
	if err != nil {
		t.Fatal(err)
	}

	// Worker 1 thức dậy cố gắng ghi đè kết quả thất bại (MarkFailed)
	err = tq.MarkFailed(ctx, taskID, workerID1, "error-from-worker-1")
	if err != nil {
		t.Errorf("MarkFailed should not return error, got %v", err)
	}

	// Kiểm tra: trạng thái task phải giữ nguyên là 'processing' của Worker 2
	task, err = tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusProcessing) {
		t.Errorf("expected status to remain processing, got %s", task.Status)
	}
	if task.WorkerID.Bytes != workerID2.Bytes {
		t.Errorf("expected worker_id to remain workerID2, got %s", task.WorkerID.String())
	}
}

func TestTaskqueue_WorkerStaleWakeUpSuccess(t *testing.T) {
	setupTestRegistry(nil)

	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	exec := &controlledExecutor{
		started: make(chan struct{}),
		release: make(chan struct{}),
		done:    make(chan struct{}),
		output:  []byte("success-on-late-wakeup"),
	}
	activeControlledExecMutex.Lock()
	activeControlledExec = exec
	activeControlledExecMutex.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := slog.Default()
	worker := NewWorkerRaw(tq, logger, make(chan string, 1))
	worker.heartbeat = 1 * time.Hour
	worker.pollIdle = 50 * time.Millisecond

	go worker.Run(ctx)

	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}
	_, err := tq.CreateTask(ctx, taskID, lessonID, pgtype.UUID{}, userID, "controlled_task", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = tq.EnqueuePendingBatch(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-exec.started:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker to claim task")
	}

	task, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusProcessing) {
		t.Fatalf("expected status to be processing, got %s", task.Status)
	}

	err = db.WithConnectionExec(pool, ctx, func(q *gen.Queries, conn *pgxpool.Conn) error {
		_, err := conn.Exec(ctx, `
			UPDATE tasks
			SET heartbeat = $2
			WHERE id = $1`,
			taskID, time.Now().UTC().Add(-2*time.Hour))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	close(exec.release)

	select {
	case <-exec.done:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for executor to complete")
	}

	time.Sleep(100 * time.Millisecond)

	task, err = tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusSucceeded) {
		t.Errorf("expected status to be succeeded, got %s", task.Status)
	}
	if string(task.OutputPayload) != "success-on-late-wakeup" {
		t.Errorf("expected output to be success-on-late-wakeup, got %s", string(task.OutputPayload))
	}

	// Verify that worker 2 ignores (cannot claim) the succeeded task
	worker2IDRaw, _ := uuid.NewV7()
	worker2ID := pgtype.UUID{Bytes: [16]byte(worker2IDRaw), Valid: true}
	_, err = tq.ClaimNextInqueuedTask(ctx, worker2ID)
	if err == nil {
		t.Error("expected worker 2 to fail claiming succeeded task, but got no error")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("expected pgx.ErrNoRows when worker 2 claims task, got: %v", err)
	}

	// Verify that scanner ignores (cannot reap) the succeeded task
	reaped, err := tq.ReapStaleProcessingBatch(ctx, 1, 0)
	if err != nil {
		t.Fatalf("ReapStaleProcessingBatch failed: %v", err)
	}
	if len(reaped) > 0 {
		t.Errorf("expected 0 tasks to be reaped, got %d", len(reaped))
	}

	// Verify task status remains succeeded and worker_id is cleared as per MarkSucceeded behavior
	finalTask, err := tq.GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if finalTask.Status != string(StatusSucceeded) {
		t.Errorf("expected status to remain succeeded, got %s", finalTask.Status)
	}
	if finalTask.WorkerID.Valid {
		t.Errorf("expected worker_id to be cleared (NULL) after success, got %s", finalTask.WorkerID.String())
	}
}

func TestTaskqueue_WorkerStaleWakeUpFailed(t *testing.T) {
	setupTestRegistry(nil)

	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	exec1 := &controlledExecutor{
		started: make(chan struct{}),
		release: make(chan struct{}),
		done:    make(chan struct{}),
		output:  []byte("out1"),
	}
	activeControlledExecMutex.Lock()
	activeControlledExec = exec1
	activeControlledExecMutex.Unlock()

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()

	logger := slog.Default()
	worker1 := NewWorkerRaw(tq, logger, make(chan string, 1))
	worker1.heartbeat = 1 * time.Hour
	worker1.pollIdle = 50 * time.Millisecond

	go worker1.Run(ctx1)

	taskIDRaw, _ := uuid.NewV7()
	taskID := pgtype.UUID{Bytes: [16]byte(taskIDRaw), Valid: true}
	_, err := tq.CreateTask(ctx1, taskID, lessonID, pgtype.UUID{}, userID, "controlled_task", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = tq.EnqueuePendingBatch(ctx1, 1)
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-exec1.started:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker 1 to claim task")
	}

	_, err = tq.ReapStaleProcessingBatch(ctx1, 1, 0)
	if err != nil {
		t.Fatal(err)
	}

	task, err := tq.GetTask(ctx1, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusInqueued) {
		t.Fatalf("expected status after reap to be inqueued, got %s", task.Status)
	}

	exec2 := &controlledExecutor{
		started: make(chan struct{}),
		release: make(chan struct{}),
		done:    make(chan struct{}),
		output:  []byte("success-from-worker-2"),
	}
	activeControlledExecMutex.Lock()
	activeControlledExec = exec2
	activeControlledExecMutex.Unlock()

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()

	worker2 := NewWorkerRaw(tq, logger, make(chan string, 1))
	worker2.heartbeat = 1 * time.Hour
	worker2.pollIdle = 50 * time.Millisecond

	go worker2.Run(ctx2)

	select {
	case <-exec2.started:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker 2 to claim task")
	}

	close(exec1.release)
	select {
	case <-exec1.done:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker 1 executor to finish")
	}

	time.Sleep(100 * time.Millisecond)

	task, err = tq.GetTask(ctx1, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusProcessing) {
		t.Errorf("expected status to remain processing, got %s", task.Status)
	}
	if task.WorkerID.Bytes != uuidBytes(worker2.WorkerID()) {
		t.Errorf("expected worker_id to remain worker2's id, got %s", task.WorkerID.String())
	}

	close(exec2.release)
	select {
	case <-exec2.done:
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for worker 2 executor to finish")
	}

	time.Sleep(100 * time.Millisecond)

	task, err = tq.GetTask(ctx1, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != string(StatusSucceeded) {
		t.Errorf("expected status to be succeeded, got %s", task.Status)
	}
	if string(task.OutputPayload) != "success-from-worker-2" {
		t.Errorf("expected output to be success-from-worker-2, got %s", string(task.OutputPayload))
	}
}

var (
	parallelRegisterOnce     sync.Once
	activeParallelCoordMutex sync.Mutex
	activeParallelCoord      *parallelCoordinator
)

type parallelCoordinator struct {
	started     chan struct{}
	bothStarted chan struct{}
	release     chan struct{}
	mu          sync.Mutex
	count       int
}

func (c *parallelCoordinator) taskStarted() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.count++
	if c.count == 1 {
		close(c.started)
	} else if c.count == 2 {
		close(c.bothStarted)
	}
}

type parallelExecutor struct {
	coord *parallelCoordinator
}

func (e *parallelExecutor) Kind() string { return "parallel_test_task" }
func (e *parallelExecutor) Execute(ctx context.Context, env *Env) ([]byte, error) {
	e.coord.taskStarted()
	select {
	case <-e.coord.release:
		return []byte("success-parallel"), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestTaskqueue_TasksRunInParallel(t *testing.T) {
	pool := do.MustInvoke[*db.PostgresSvc](internal.Injector)
	clearAllTasks(t, pool)
	tq := NewPostgresDB(pool)
	userID, lessonID := getOrCreateTestUserAndLesson(t, pool)

	coord := &parallelCoordinator{
		started:     make(chan struct{}),
		bothStarted: make(chan struct{}),
		release:     make(chan struct{}),
	}

	activeParallelCoordMutex.Lock()
	activeParallelCoord = coord
	activeParallelCoordMutex.Unlock()

	parallelRegisterOnce.Do(func() {
		Register("parallel_test_task", func() Executor {
			activeParallelCoordMutex.Lock()
			defer activeParallelCoordMutex.Unlock()
			return &parallelExecutor{coord: activeParallelCoord}
		})
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. Create two parallel tasks
	task1IDRaw, _ := uuid.NewV7()
	task1ID := pgtype.UUID{Bytes: [16]byte(task1IDRaw), Valid: true}
	_, err := tq.CreateTask(ctx, task1ID, lessonID, pgtype.UUID{}, userID, "parallel_test_task", []byte("t1"))
	if err != nil {
		t.Fatal(err)
	}

	task2IDRaw, _ := uuid.NewV7()
	task2ID := pgtype.UUID{Bytes: [16]byte(task2IDRaw), Valid: true}
	_, err = tq.CreateTask(ctx, task2ID, lessonID, pgtype.UUID{}, userID, "parallel_test_task", []byte("t2"))
	if err != nil {
		t.Fatal(err)
	}

	// 2. Enqueue both
	_, err = tq.EnqueuePendingBatch(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}

	// 3. Start worker
	logger := slog.Default()
	worker := NewWorkerRaw(tq, logger, make(chan string, 1))
	worker.heartbeat = 1 * time.Hour
	worker.pollIdle = 50 * time.Millisecond

	go worker.Run(ctx)

	// 4. Verify both tasks start running concurrently (both must hit Execute simultaneously)
	select {
	case <-coord.bothStarted:
		// Success! Both tasks are running in parallel
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for tasks to run in parallel; they might be serialized")
	}

	// 5. Release them so they can complete
	close(coord.release)

	// Wait for processing to complete
	time.Sleep(100 * time.Millisecond)

	// 6. Verify database status shows both succeeded
	t1, err := tq.GetTask(ctx, task1ID)
	if err != nil {
		t.Fatal(err)
	}
	if t1.Status != string(StatusSucceeded) {
		t.Errorf("expected task 1 to be succeeded, got %s", t1.Status)
	}

	t2, err := tq.GetTask(ctx, task2ID)
	if err != nil {
		t.Fatal(err)
	}
	if t2.Status != string(StatusSucceeded) {
		t.Errorf("expected task 2 to be succeeded, got %s", t2.Status)
	}
}




