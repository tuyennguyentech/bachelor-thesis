package storage

import (
	"strings"
	"sync"
	"time"

	"example.com/richter/cfg"
)

// UploadRateLimiter guards a per-key presigned-upload endpoint against
// abuse (a malicious learner spam-uploading MB of audio per request).
// Implementations are strategy-pattern swappable: the storage service
// depends on this interface, not on any concrete counter store. Adding
// an FDB-backed or Redis-backed variant later only requires a new
// constructor + a branch in NewUploadRateLimiter.
type UploadRateLimiter interface {
	// Allow reports whether another presigned-upload URL may be issued
	// for the given (userID, key) tuple. Implementations must be safe
	// for concurrent use.
	Allow(userID, key string) bool
}

// NewUploadRateLimiter picks the concrete implementation based on
// configuration. The factory is the only place that knows about the
// implementations; the storage service itself stays tool-agnostic.
//
// Config:
//   - StudentUploadsPerWindow == 0 → unlimited (no-op impl; ideal for dev/test)
//   - StudentUploadsPerWindow >  0 → in-memory rolling window
func NewUploadRateLimiter(c cfg.StorageCfg) UploadRateLimiter {
	if c.StudentUploadsPerWindow <= 0 {
		return unlimitedUploadRateLimiter{}
	}
	window := c.StudentUploadWindow
	if window <= 0 {
		window = time.Minute
	}
	return &inMemoryUploadRateLimiter{
		max:    c.StudentUploadsPerWindow,
		window: window,
	}
}

// unlimitedUploadRateLimiter always allows uploads. Used when the
// operator has explicitly disabled the rate limit (e.g. dev, tests,
// or trusted single-user environments).
type unlimitedUploadRateLimiter struct{}

func (unlimitedUploadRateLimiter) Allow(_, _ string) bool { return true }

// inMemoryUploadRateLimiter is a per-process rolling-window counter.
// For a multi-instance deployment the limit would scale with the
// instance count; v2 should swap in an FDB-backed (or Redis-backed)
// counter to make the limit cluster-wide.
type inMemoryUploadRateLimiter struct {
	max    int
	window time.Duration

	mu      sync.Mutex
	buckets map[string]*uploadCounter
}

type uploadCounter struct {
	count   int
	resetAt time.Time
}

func (r *inMemoryUploadRateLimiter) Allow(userID, key string) bool {
	if userID == "" {
		// Unauthenticated case is rejected upstream; defensive allow.
		return true
	}
	bucketKey := uploadBucketKey(userID, key)
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.buckets[bucketKey]
	if !ok || now.After(c.resetAt) {
		c = &uploadCounter{resetAt: now.Add(r.window)}
		r.buckets[bucketKey] = c
	}
	if c.count >= r.max {
		return false
	}
	c.count++
	return true
}

func uploadBucketKey(userID, key string) string {
	// Bucket per (user, lesson) so the limit is per-lesson, not global
	// per-user across all lessons.
	parts := strings.SplitN(normalizeStorageKey(key), "/", 4)
	if len(parts) < 2 || parts[1] == "" {
		// Malformed keys are rejected earlier; use a sentinel so we still
		// get *some* rate limiting instead of a global per-user bucket.
		return userID + "|malformed"
	}
	return userID + "|" + parts[1]
}
