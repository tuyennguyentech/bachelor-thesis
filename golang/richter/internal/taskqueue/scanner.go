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

// Scanner runs the periodic recovery sweeps that keep the task state
// machine moving. Tasks are born 'inqueued' by the producer (and the
// pg_notify wakes a worker immediately), so the scanner NEVER creates
// queue entries — it is a pure BACKUP path that only rescues rows that
// got stuck. All racing concerns for the recovery transitions live here.
//
// Two sweeps per cycle:
//
//  1. ReapStaleProcessingBatch: rows with status='processing'
//     AND heartbeat older than staleAfter are re-enqueued. This
//     is the recovery path for crashed workers.
//
//  2. RequeueOrphanedInqueuedBatch: rows with status='inqueued'
//     that have been sitting longer than queueStaleAfter (the
//     pg_notify wake was missed, or the worker was down at insert
//     time) are re-prioritized to the head so the worker picks them
//     up. Safety net against a permanently-stranded 'inqueued' row.
type Scanner struct {
	db              DB
	interval        time.Duration // e.g. 5s
	staleAfter      time.Duration // e.g. 30s — heartbeat older than this is dead
	queueStaleAfter time.Duration // e.g. 1m — inqueued older than this gets bumped
	batchSize       int           // rows per sweep, e.g. 50
	log             *slog.Logger
	notifCh         chan string // Scanner -> Worker wake; non-blocking writes
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
