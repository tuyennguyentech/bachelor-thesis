package taskqueue

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/log"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/samber/do/v2"
)

// Listener subscribes to the 'task_created' Postgres NOTIFY channel
// and forwards wake signals to the scanner. The dedicated connection
// is NOT drawn from the shared pool (LISTEN holds the connection
// indefinitely; sharing would exhaust the pool).
//
// The pg_notify trigger is best-effort: if Postgres can't deliver
// (e.g. listener missed an event because it was reconnecting),
// the scanner's periodic cycle still picks up the row within
// staleAfter. The listener is purely a latency optimization.
type Listener struct {
	dsn      string
	notifCh  chan<- string
	log      *slog.Logger
	interval time.Duration // reconnect backoff cap
}

// NewListener returns a listener that writes a wake signal to notifCh on each
// 'task_created' NOTIFY. notifCh is the Worker's wake channel: tasks are inserted
// already 'inqueued' (StartLessonTask enqueues in the same tx), and the NOTIFY is
// delivered at COMMIT, so by the time the worker wakes the row is claimable.
func NewListener(dsn string, notifCh chan<- string, log *slog.Logger) *Listener {
	return &Listener{
		dsn:      dsn,
		notifCh:  notifCh,
		log:      log,
		interval: 30 * time.Second,
	}
}

// Run blocks until ctx is done. Reconnects with exponential backoff
// (capped at interval) on connection errors.
func (l *Listener) Run(ctx context.Context) {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			l.log.InfoContext(ctx, "taskqueue.Listener: stopping")
			return
		default:
		}
		if err := l.runOnce(ctx); err != nil {
			l.log.WarnContext(ctx, "taskqueue.Listener: connection error, will reconnect",
				"err", err, "backoff", backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < l.interval {
			backoff *= 2
			if backoff > l.interval {
				backoff = l.interval
			}
		}
	}
}

func (l *Listener) runOnce(ctx context.Context) error {
	// Direct pgx.Connect (not pool) — LISTEN holds a single
	// connection indefinitely. Using a pool here would leak
	// a connection.
	conn, err := pgx.Connect(ctx, l.dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	if _, err := conn.Exec(ctx, "LISTEN task_created"); err != nil {
		return err
	}
	l.log.InfoContext(ctx, "taskqueue.Listener: listening on task_created")

	for {
		// WaitForNotification blocks until a NOTIFY arrives or
		// the connection errors. Use a goroutine + select so
		// ctx cancellation can interrupt.
		notifCh := make(chan *pgconn.Notification, 1)
		errCh := make(chan error, 1)
		go func() {
			n, e := conn.WaitForNotification(ctx)
			if e != nil {
				errCh <- e
				return
			}
			notifCh <- n
		}()
		select {
		case <-ctx.Done():
			return nil
		case err := <-errCh:
			return err
		case n := <-notifCh:
			if n == nil {
				continue
			}
			// Wake the worker. Best-effort: if its channel is full, drop and rely
			// on the worker's poll / the scanner's periodic cycle to catch up.
			select {
			case l.notifCh <- n.Payload:
			default:
			}
		}
	}
}

// NewListenerFromDI builds a Listener using PostgresCfg from the
// injector and a shared notification channel from the Scanner.
func NewListenerFromDI(i do.Injector) (*Listener, error) {
	pg, err := do.Invoke[*cfg.PostgresCfg](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewListener: PostgresCfg: %w", err)
	}
	scanner, err := do.Invoke[*Scanner](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewListener: Scanner: %w", err)
	}
	logSvc, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewListener: LogSvc: %w", err)
	}
	return NewListener(pg.DSN(), scanner.notifCh, &logSvc.Logger), nil
}
