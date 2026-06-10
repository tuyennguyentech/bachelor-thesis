package taskqueue

import (
	"context"
	"fmt"
	"sync"
)

// Executor is the contract every concrete task type must satisfy.
//
// A task type is identified by a string kind ("transcribe", "quiz_gen",
// "transcribe_then_quiz", etc.). The worker uses the registry to
// resolve a kind to a Factory that produces an Executor instance
// each time a new task needs to run.
//
// Dependencies are NOT a parameter to Execute. The Factory closure
// is the place where DI happens — once and for all at registration
// time, not every call. This keeps the queue layer free of
// per-call DI lookups and makes the executor's data dependencies
// obvious from its constructor.
//
// Execute performs the work and returns raw output bytes (the
// executor's own proto-encoded output, owned by the task). The
// worker writes those bytes to tasks.output_payload and transitions
// the row to succeeded.
//
// Execute MUST honour ctx cancellation. The worker cancels ctx
// when (a) the row's heartbeat write returns 0 rows (the task
// was stolen or cancelled) or (b) the worker is shutting down.
// Returning ctx.Err() lets the worker skip the status update
// because the row already moved on.
type Executor interface {
	Kind() string
	Execute(ctx context.Context, env *Env) (output []byte, err error)
}

// Factory creates a fresh Executor. Factories are closures over DI
// dependencies resolved at registration time. The worker calls
// this once per task claim to get a stateless executor instance.
type Factory func() Executor

var (
	registryMu sync.RWMutex
	registry   = map[string]Factory{}
)

// Register binds a task kind to its factory. Panics on duplicate
// registration because that's a programmer error caught at startup.
func Register(kind string, f Factory) {
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, exists := registry[kind]; exists {
		panic(fmt.Sprintf("taskqueue: duplicate registration for kind %q", kind))
	}
	registry[kind] = f
}

// Lookup returns the factory for a kind, or nil if none. Callers
// must treat a nil return as "unknown kind" and fail the task
// rather than retry.
func Lookup(kind string) Factory {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return registry[kind]
}

// RegisteredKinds returns the kinds currently registered. Useful
// for startup sanity checks and tests.
func RegisteredKinds() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	return out
}
