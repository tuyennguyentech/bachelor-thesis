// Package taskqueue is the abstract infrastructure for long-running
// task processing. It is intentionally domain-agnostic — it does not
// know what a "transcribe" or "quiz_gen" task does. Concrete task
// executors live in sibling packages (e.g. aitasks/executors) and
// implement the Executor interface registered via init().
//
// Design invariants:
//
//  1. The tasks table is the single source of truth for task state.
//     FDB is NOT used for task queue, state, or ownership. (FDB may
//     still hold domain payload bytes for the executor to consume,
//     but that is the executor's problem, not the queue's.)
//
//  2. Worker identity = UUID v7, generated once per worker process.
//     A worker uses its id to mark task ownership on claim and to
//     prove identity on heartbeat / terminal write. The terminal
//     write's WHERE clause (worker_id=me AND status='processing')
//     is what prevents a zombie worker from corrupting state.
//
//  3. At-least-once delivery: the worker may receive a task more
//     than once (crash + reconnect). Terminal writes are idempotent
//     because they only succeed if the row is still in the expected
//     state under our ownership. The executor's Execute must be
//     safe to call multiple times for the same task; if it's
//     expensive work, the executor should checkpoint progress to
//     output_payload after each major step.
//
//  4. Tasks are born 'inqueued' (the producer inserts them already
//     queued, and pg_notify wakes a worker at once). The scanner does
//     only recovery bookkeeping — processing -> inqueued on heartbeat
//     timeout, and inqueued -> head of queue on requeue. It uses
//     FOR UPDATE SKIP LOCKED so multiple scanner goroutines on the
//     same or different processes don't fight.
//
//  5. Input/output payloads are raw proto bytes. The queue layer
//     doesn't parse them; the executor does, with its own
//     message type. This keeps the queue generic across kinds.
package taskqueue
