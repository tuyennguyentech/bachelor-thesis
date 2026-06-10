package taskqueue

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/log"
	"github.com/samber/do/v2"
)

// Scanner runs the three periodic sweeps that keep the task state
// machine moving. It is the only place where pending -> inqueued
// and processing -> inqueued transitions happen, so all racing
// concerns live here.
//
// Three sweeps per cycle:
//
//   1. EnqueuePendingBatch: rows with status='pending' become
//      'inqueued' and get a queue_seq. The pg_notify trigger on
//      INSERT means a fresh pending row wakes the worker within
//      milliseconds, not seconds. The periodic sweep is just
//      belt-and-suspenders for missed notifications.
//
//   2. ReapStaleProcessingBatch: rows with status='processing'
//      AND heartbeat older than staleAfter are re-enqueued. This
//      is the recovery path for crashed workers.
//
//   3. RequeueOrphanedInqueuedBatch: rows with status='inqueued'
//      that have been sitting longer than queueStaleAfter are
//      re-prioritized. Safety net for cases where a downstream
//      push (e.g. a payload store) failed silently and left the
//      task stranded in 'inqueued' forever.
type Scanner struct {
	db              DB
	interval        time.Duration  // e.g. 5s
	staleAfter      time.Duration  // e.g. 30s — heartbeat older than this is dead
	queueStaleAfter time.Duration  // e.g. 1m — inqueued older than this gets bumped
	batchSize       int            // rows per sweep, e.g. 50
	log             *slog.Logger
	notifCh         chan string    // shared with Listener; non-blocking writes
}

// NewScannerRaw returns a scanner with sensible defaults. Callers can
// tune the durations if they need to.
func NewScannerRaw(db DB, log *slog.Logger) *Scanner {
	return &Scanner{
		db:              db,
		interval:        5 * time.Second,
		staleAfter:      30 * time.Second,
		queueStaleAfter: 1 * time.Minute,
		batchSize:       50,
		log:             log,
		notifCh:         make(chan string, 64),
	}
}

// NotifCh returns the channel Listener writes to and Worker reads
// from. Exposed for DI wiring.
func (s *Scanner) NotifCh() <-chan string { return s.notifCh }

// WithInterval overrides the periodic scan interval.
func (s *Scanner) WithInterval(d time.Duration) *Scanner {
	s.interval = d
	return s
}

// WithStaleAfter overrides the heartbeat-stale threshold.
func (s *Scanner) WithStaleAfter(d time.Duration) *Scanner {
	s.staleAfter = d
	return s
}

// Run blocks until ctx is done. Spawn it in a goroutine from
// service startup.
func (s *Scanner) Run(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	s.log.InfoContext(ctx, "taskqueue.Scanner: started",
		"interval", s.interval,
		"stale_after", s.staleAfter,
		"queue_stale_after", s.queueStaleAfter,
		"batch_size", s.batchSize)
	for {
		select {
		case <-ctx.Done():
			s.log.InfoContext(ctx, "taskqueue.Scanner: stopping")
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Scanner) tick(ctx context.Context) {
	enqueued, err := s.db.EnqueuePendingBatch(ctx, s.batchSize)
	if err != nil {
		s.log.WarnContext(ctx, "taskqueue.Scanner: enqueue failed", "err", err)
	} else if len(enqueued) > 0 {
		s.log.InfoContext(ctx, "taskqueue.Scanner: pending -> inqueued", "count", len(enqueued))
		// Wake the Worker so it claims the newly inqueued tasks
		// immediately instead of waiting for the next poll cycle.
		for range len(enqueued) {
			select {
			case s.notifCh <- "":
			default:
			}
		}
	}

	reaped, err := s.db.ReapStaleProcessingBatch(ctx, s.batchSize, s.staleAfter)
	if err != nil {
		s.log.WarnContext(ctx, "taskqueue.Scanner: reap failed", "err", err)
	} else if len(reaped) > 0 {
		s.log.InfoContext(ctx, "taskqueue.Scanner: processing -> inqueued (stale heartbeat)",
			"count", len(reaped))
		for range len(reaped) {
			select {
			case s.notifCh <- "":
			default:
			}
		}
	}

	requeued, err := s.db.RequeueOrphanedInqueuedBatch(ctx, s.batchSize, s.queueStaleAfter)
	if err != nil {
		s.log.WarnContext(ctx, "taskqueue.Scanner: requeue orphaned failed", "err", err)
	} else if len(requeued) > 0 {
		s.log.InfoContext(ctx, "taskqueue.Scanner: re-prioritized stale inqueued",
			"count", len(requeued))
		for range len(requeued) {
			select {
			case s.notifCh <- "":
			default:
			}
		}
	}
}

// NewScannerFromDI builds a Scanner with dependencies pulled from
// the injector. Exists as a separate function (NewScanner is the
// raw constructor; this is the DI factory) so the package doesn't
// need to import do at the top.
func NewScanner(i do.Injector) (*Scanner, error) {
	db, err := NewDB(i)
	if err != nil {
		return nil, err
	}
	logSvc, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewScanner: LogSvc: %w", err)
	}
	taskCfg, err := do.Invoke[*cfg.LessonTaskCfg](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.NewScanner: LessonTaskCfg: %w", err)
	}
	s := NewScannerRaw(db, &logSvc.Logger)
	if taskCfg.StaleCheckInterval > 0 {
		s.interval = taskCfg.StaleCheckInterval
	}
	if taskCfg.HeartbeatTimeout > 0 {
		s.staleAfter = taskCfg.HeartbeatTimeout
	}
	return s, nil
}
