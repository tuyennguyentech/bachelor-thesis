package taskqueue

import (
	"log/slog"
)

// Env is the runtime context handed to every Executor.Execute call.
// Intentionally minimal — executors own their own dependency fields
// (set at construction time via DI, not pulled from this struct).
//
// Input is the raw proto bytes from tasks.input_payload. The
// executor is responsible for unmarshalling them with its own
// message type; the queue layer doesn't know the schema.
type Env struct {
	TaskID   string
	TaskType string
	WorkerID string
	Logger   *slog.Logger
	Input    []byte
	// PriorOutput is the task's existing output_payload at claim time. Empty on
	// a fresh run; after a crash + reclaim it carries the last checkpoint an
	// executor wrote, so a resumable executor can skip already-completed work.
	PriorOutput []byte
	// StageLabel, when set, is the coarse pipeline stage a composite executor is
	// currently in (e.g. "TRANSCRIBING"). Sub-step progress callbacks report this
	// as the task's progress_step instead of their own fine-grained enum, so a
	// FE driven by the coarse stage isn't confused by sub-steps that are reused
	// across stages (e.g. ANALYZING is emitted by both transcribe and chunk).
	StageLabel string
}
