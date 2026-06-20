package taskqueue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/log"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/samber/do/v2"
)

// Worker is a single long-running process that claims inqueued
// tasks, runs them, and emits heartbeats. There is typically
// exactly one Worker per richter process; multiple Workers in
// different processes cooperate via the FOR UPDATE SKIP LOCKED
// claim and the per-worker ownership check on terminal writes.
//
// Each Worker carries a UUID v7 worker_id assigned at construction
// time. The worker_id is the proof of ownership for:
//   - ClaimNextInqueuedTask (UPDATE sets worker_id=me)
//   - HeartbeatTask (UPDATE WHERE id=? AND worker_id=me)
//   - MarkSucceeded/MarkFailed (WHERE id=? AND worker_id=me)
//
// A zombie worker that wakes up after a freeze sees its old
// worker_id has been cleared by the scanner (after heartbeat
// timeout) and re-claimed by another worker. The ownership check
// on terminal writes is what prevents it from corrupting state.
type Worker struct {
	id                string // UUID v7, generated once at construction
	db                DB
	log               *slog.Logger
	active            sync.Map       // taskID -> *managedTask
	taskGoroutines    sync.WaitGroup // counts in-flight task goroutines
	heartbeat         time.Duration  // interval between heartbeat ticks
	pollIdle          time.Duration  // interval between claim attempts when queue empty
	heartbeatFreshFor time.Duration  // heartbeat older than this => worker lost ownership
	workers           int            // concurrency: number of worker loops, 0 = runtime.NumCPU()
	notifCh           <-chan string  // pg_notify wake signal from Listener via Scanner
	allowedTypes      []string       // task_types this worker may claim; must be non-empty
}

// NewWorkerRaw generates a UUID v7 worker_id and returns a Worker
// ready to Run. notifCh is the pg_notify wake signal from the
// Listener (via Scanner). When a task is INSERTed, the Listener
// writes the task ID to this channel, and the Worker's taskLoop
// wakes immediately instead of waiting for the 2s poll.
func NewWorkerRaw(db DB, log *slog.Logger, notifCh <-chan string) *Worker {
	id, err := uuid.NewV7()
	if err != nil {
		panic("taskqueue: NewV7 failed: " + err.Error())
	}
	return &Worker{
		id:                id.String(),
		db:                db,
		log:               log,
		heartbeat:         10 * time.Second,
		pollIdle:          2 * time.Second,
		heartbeatFreshFor: 30 * time.Second,
		notifCh:           notifCh,
	}
}

// WorkerID returns the UUID v7 this worker was assigned.
func (w *Worker) WorkerID() string { return w.id }

// WithAllowedTypes restricts this worker to claiming only tasks whose
// task_type is in the provided list. This MUST be called before Run.
// Workers with an empty allowedTypes will not claim any tasks.
func (w *Worker) WithAllowedTypes(types []string) *Worker {
	w.allowedTypes = types
	return w
}

// Run starts the worker pool. Blocks until ctx is done. Spawns:
//   - 1 heartbeat goroutine
//   - NumCPU task goroutines that each loop: claim -> run -> repeat
//   - 1 reconnect goroutine that runs once on startup
func (w *Worker) Run(ctx context.Context) {
	// 3. Task loops: configured or NumCPU goroutines competing for claims.
	workersCount := runtime.NumCPU()
	if w.workers > 0 {
		workersCount = w.workers
	}
	w.log.InfoContext(ctx, "taskqueue.Worker: started",
		"worker_id", w.id, "goroutines", workersCount)

	// 1. Reconnect: take back tasks that were in flight under
	//    our worker_id at the time of the previous crash.
	w.reconnect(ctx)

	// 2. Heartbeat loop: 1 goroutine per worker.
	go w.heartbeatLoop(ctx)

	// 3. Task loops: configured or NumCPU goroutines competing for claims.
	for i := 0; i < workersCount; i++ {
		w.taskGoroutines.Add(1)
		go func() {
			defer w.taskGoroutines.Done()
			w.taskLoop(ctx)
		}()
	}

	<-ctx.Done()
	w.log.InfoContext(ctx, "taskqueue.Worker: shutdown signal received, draining")

	// Cancel all in-flight task contexts so executors return.
	w.active.Range(func(key, _ any) bool {
		if managed, ok := w.active.Load(key); ok {
			managed.(*managedTask).cancel()
		}
		return true
	})

	// Wait for task goroutines to exit.
	w.taskGoroutines.Wait()
	w.log.InfoContext(ctx, "taskqueue.Worker: drained")
}

func (w *Worker) reconnect(ctx context.Context) {
	workerID := pgtype.UUID{Bytes: uuidBytes(w.id), Valid: true}
	cutoff := time.Now().UTC().Add(-w.heartbeatFreshFor)
	tasks, err := w.db.ReconnectCandidates(ctx, workerID, cutoff)
	if err != nil {
		w.log.WarnContext(ctx, "taskqueue.Worker: reconnect query failed", "err", err)
		return
	}
	if len(tasks) == 0 {
		return
	}
	w.log.InfoContext(ctx, "taskqueue.Worker: reconnecting to in-flight tasks", "count", len(tasks))
	for _, t := range tasks {
		w.spawnTask(ctx, t)
	}
}

func (w *Worker) taskLoop(ctx context.Context) {
	if len(w.allowedTypes) == 0 {
		// No allowed types configured — this worker must not claim any tasks.
		// Block until ctx is cancelled so the goroutine exits cleanly.
		w.log.WarnContext(ctx, "taskqueue.Worker: no allowedTypes configured, worker is idle")
		<-ctx.Done()
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		workerID := pgtype.UUID{Bytes: uuidBytes(w.id), Valid: true}
		task, err := w.db.ClaimNextInqueuedTask(ctx, workerID, w.allowedTypes)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Queue empty. Wait for either a pg_notify wake
				// or the pollIdle timeout, whichever comes first.
				select {
				case <-ctx.Done():
					return
				case <-w.notifCh:
					// Task INSERTed — loop immediately to claim.
					continue
				case <-time.After(w.pollIdle):
				}
				continue
			}
			w.log.WarnContext(ctx, "taskqueue.Worker: claim failed", "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(w.pollIdle):
			}
			continue
		}
		w.spawnTask(ctx, task)
	}
}

func (w *Worker) spawnTask(ctx context.Context, task Task) {
	taskCtx, cancel := context.WithCancel(ctx)
	managed := &managedTask{cancel: cancel}
	w.active.Store(task.ID.String(), managed)
	w.taskGoroutines.Add(1)
	go func() {
		defer w.taskGoroutines.Done()
		defer w.active.Delete(task.ID.String())
		w.runTask(taskCtx, task)
	}()
}

func (w *Worker) runTask(ctx context.Context, task Task) {
	factory := Lookup(task.TaskType)
	if factory == nil {
		w.log.WarnContext(ctx, "taskqueue.Worker: unknown task type, marking failed",
			"task_id", task.ID.String(), "task_type", task.TaskType)
		workerID := pgtype.UUID{Bytes: uuidBytes(w.id), Valid: true}
		_ = w.db.MarkFailed(ctx, task.ID, workerID,
			"unknown task type: "+task.TaskType)
		return
	}

	executor := factory()
	// Make the inqueued -> processing transition visible: previously the only
	// task-lifecycle INFO line was the Scanner's "pending -> inqueued", so a task
	// being picked up and run by a worker left no trace.
	w.log.InfoContext(ctx, "taskqueue.Worker: claimed task (inqueued -> processing)",
		"task_id", task.ID.String(), "task_type", task.TaskType, "worker_id", w.id)
	start := time.Now()
	env := &Env{
		TaskID:      task.ID.String(),
		TaskType:    task.TaskType,
		WorkerID:    w.id,
		Logger:      w.log,
		Input:       task.InputPayload,
		PriorOutput: task.OutputPayload,
	}

	output, err := executor.Execute(ctx, env)
	if errors.Is(err, context.Canceled) {
		// Cancelled by heartbeat steal or shutdown. Don't
		// touch the row — the scanner or user cancel is in
		// charge of the terminal write.
		return
	}
	workerID := pgtype.UUID{Bytes: uuidBytes(w.id), Valid: true}
	if err != nil {
		// Log the executor failure itself — previously only a MarkFailed write
		// error was logged, so a failing task (e.g. Whisper model not installed)
		// was stored in error_msg and surfaced to the user but left ZERO backend
		// log lines, making it un-diagnosable from the server side.
		w.log.ErrorContext(ctx, "taskqueue.Worker: task failed",
			"task_id", task.ID.String(), "task_type", task.TaskType, "err", err)
		if markErr := w.db.MarkFailed(ctx, task.ID, workerID, err.Error()); markErr != nil {
			w.log.WarnContext(ctx, "taskqueue.Worker: MarkFailed",
				"task_id", task.ID.String(), "err", markErr)
		}
		return
	}
	if markErr := w.db.MarkSucceeded(ctx, task.ID, workerID, output); markErr != nil {
		w.log.WarnContext(ctx, "taskqueue.Worker: MarkSucceeded",
			"task_id", task.ID.String(), "err", markErr)
		return
	}
	w.log.InfoContext(ctx, "taskqueue.Worker: task succeeded (processing -> succeeded)",
		"task_id", task.ID.String(), "task_type", task.TaskType, "duration", time.Since(start))
}

func (w *Worker) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(w.heartbeat)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		workerID := pgtype.UUID{Bytes: uuidBytes(w.id), Valid: true}
		w.active.Range(func(key, value any) bool {
			taskID, ok := key.(pgtype.UUID)
			if !ok {
				// Stored with string keys (UUID.String()), so
				// look up by string form.
				if s, sok := key.(string); sok {
					taskID = pgtype.UUID{Bytes: uuidBytes(s), Valid: true}
				} else {
					return true
				}
			}
			managed, _ := value.(*managedTask)
			n, err := w.db.HeartbeatTask(ctx, taskID, workerID)
			if err != nil {
				w.log.WarnContext(ctx, "taskqueue.Worker: heartbeat error",
					"task_id", taskID.String(), "err", err)
				return true
			}
			if n == 0 {
				// Either stolen (worker_id != us) or cancelled
				// (status != 'processing'). Cancel the local
				// goroutine; the row is somebody else's problem.
				if managed != nil {
					managed.cancel()
				}
				w.active.Delete(key)
				w.log.InfoContext(ctx, "taskqueue.Worker: task lost ownership, cancelling local",
					"task_id", taskID.String())
			}
			return true
		})
	}
}

type managedTask struct {
	cancel context.CancelFunc
}

// uuidBytes parses a UUID string into a [16]byte suitable for
// pgtype.UUID. Uses google/uuid's parser for correctness.
func uuidBytes(s string) [16]byte {
	u, err := uuid.Parse(s)
	if err != nil {
		// Worker IDs are generated from uuid.NewV7 which always
		// produces a valid string. If parsing fails the system
		// is in a bad state.
		panic("taskqueue: invalid worker id " + s + ": " + err.Error())
	}
	return [16]byte(u)
}

// NewWorkerFromDI builds a Worker with dependencies from the
// injector. Subscribes to the Scanner's notification channel so
// the worker wakes the moment a new task hits the queue.
func NewWorker(i do.Injector) (*Worker, error) {
	db, err := NewDB(i)
	if err != nil {
		return nil, err
	}
	logSvc, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewWorker: LogSvc: %w", err)
	}
	scanner, err := do.Invoke[*Scanner](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewWorker: Scanner: %w", err)
	}
	taskCfg, err := do.Invoke[*cfg.LessonTaskCfg](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewWorker: LessonTaskCfg: %w", err)
	}
	w := NewWorkerRaw(db, &logSvc.Logger, scanner.NotifCh())
	w.allowedTypes = RegisteredKinds()
	if taskCfg.Workers > 0 {
		w.workers = taskCfg.Workers
	}
	if taskCfg.HeartbeatInterval > 0 {
		w.heartbeat = taskCfg.HeartbeatInterval
	}
	if taskCfg.HeartbeatTimeout > 0 {
		w.heartbeatFreshFor = taskCfg.HeartbeatTimeout
	}
	if taskCfg.PollInterval > 0 {
		w.pollIdle = taskCfg.PollInterval
	}
	return w, nil
}
