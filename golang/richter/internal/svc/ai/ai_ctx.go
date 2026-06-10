package ai

import (
	"context"
	"time"
)

// aiCtx returns a child of ctx with the given timeout, or returns ctx
// unchanged when d is 0 (unlimited). The caller must defer the cancel
// to release resources when d > 0; when d == 0 the returned cancel is
// a no-op so callers can still defer it safely. Clamps negative values
// to 0 (= unlimited).
func (s *AISvc) aiCtx(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, d)
}

// chunksLimit returns the configured chunk list limit as int32 (the
// sqlc-generated SQL params use int32), falling back to 500 when unset
// (0) — protects against accidentally unbounded scans if a deployment
// forgets to set cfg.
func (s *AISvc) chunksLimit() int32 {
	if s.aiCfg == nil || s.aiCfg.ListLimitChunks <= 0 {
		return 500
	}
	return int32(s.aiCfg.ListLimitChunks)
}

// interactionsLimit returns the configured interaction list limit as
// int32, falling back to 5000 when unset.
func (s *AISvc) interactionsLimit() int32 {
	if s.aiCfg == nil || s.aiCfg.ListLimitInteractions <= 0 {
		return 5000
	}
	return int32(s.aiCfg.ListLimitInteractions)
}

// lessonOpsLimit returns the configured lesson-ops list limit as int32
// (used by read-transcript, re-chunk, etc.), falling back to 10000 when
// unset.
func (s *AISvc) lessonOpsLimit() int32 {
	if s.aiCfg == nil || s.aiCfg.ListLimitLessonOps <= 0 {
		return 10000
	}
	return int32(s.aiCfg.ListLimitLessonOps)
}
