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
}
