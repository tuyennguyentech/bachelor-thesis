package storage

import (
	"testing"
	"time"

	"example.com/richter/cfg"
)

func TestUnlimitedUploadRateLimiter_AlwaysAllows(t *testing.T) {
	lim := unlimitedUploadRateLimiter{}
	// 1000 calls from the same user on the same key must all pass.
	for i := 0; i < 1000; i++ {
		if !lim.Allow("u", "lessons/L/student-recordings/x.webm") {
			t.Fatalf("unlimited limiter rejected call %d", i)
		}
	}
}

func TestNewUploadRateLimiter_ZeroIsUnlimited(t *testing.T) {
	// The dev / test escape hatch: a zero per-window value must yield the
	// no-op implementation so E2E loops and dev iteration never get throttled.
	got := NewUploadRateLimiter(cfg.StorageCfg{StudentUploadsPerWindow: 0, StudentUploadWindow: time.Minute})
	if _, ok := got.(unlimitedUploadRateLimiter); !ok {
		t.Fatalf("StudentUploadsPerWindow=0 must yield unlimitedUploadRateLimiter, got %T", got)
	}
	// Negative values are also treated as "disabled" so a config typo can't
	// silently enable the limiter.
	got = NewUploadRateLimiter(cfg.StorageCfg{StudentUploadsPerWindow: -1, StudentUploadWindow: time.Minute})
	if _, ok := got.(unlimitedUploadRateLimiter); !ok {
		t.Fatalf("StudentUploadsPerWindow<0 must yield unlimitedUploadRateLimiter, got %T", got)
	}
}

func TestNewUploadRateLimiter_PositiveIsInMemory(t *testing.T) {
	got := NewUploadRateLimiter(cfg.StorageCfg{StudentUploadsPerWindow: 3, StudentUploadWindow: 30 * time.Second})
	if _, ok := got.(*inMemoryUploadRateLimiter); !ok {
		t.Fatalf("StudentUploadsPerWindow>0 must yield inMemoryUploadRateLimiter, got %T", got)
	}
	lim := got.(*inMemoryUploadRateLimiter)
	if lim.max != 3 || lim.window != 30*time.Second {
		t.Fatalf("limiter did not pick up config: max=%d window=%s", lim.max, lim.window)
	}
	// A zero window with a positive limit falls back to 1 minute so the
	// limiter still behaves as a rolling window.
	got = NewUploadRateLimiter(cfg.StorageCfg{StudentUploadsPerWindow: 3})
	if lim = got.(*inMemoryUploadRateLimiter); lim.window != time.Minute {
		t.Fatalf("StudentUploadWindow=0 must default to 1m, got %s", lim.window)
	}
}

func TestInMemoryUploadRateLimiter(t *testing.T) {
	const max = 3
	r := &inMemoryUploadRateLimiter{
		max:     max,
		window:  time.Hour,
		buckets: map[string]*uploadCounter{},
	}
	user := "user-rate-test"
	lessonID := "lesson-rate-test"

	// First `max` calls must succeed.
	for i := 0; i < max; i++ {
		key := "lessons/" + lessonID + "/student-recordings/uuid-" + string(rune('a'+i)) + ".webm"
		if !r.Allow(user, key) {
			t.Fatalf("call %d/%d unexpectedly rejected", i+1, max)
		}
	}
	// The next upload for the same lesson must be rejected even with a new filename.
	if r.Allow(user, "lessons/"+lessonID+"/student-recordings/new-name.webm") {
		t.Fatalf("call %d should have been rejected by rate limit", max+1)
	}

	// Different user on the same lesson is independent.
	if !r.Allow("other-user", "lessons/"+lessonID+"/student-recordings/uuid.webm") {
		t.Fatal("rate limit must be per-user, not per-key")
	}

	// Same user on a different lesson is independent.
	if !r.Allow(user, "lessons/other-lesson/student-recordings/uuid.webm") {
		t.Fatal("rate limit must be per-lesson, not global per-user")
	}
}

func TestInMemoryUploadRateLimiter_WindowResets(t *testing.T) {
	r := &inMemoryUploadRateLimiter{max: 1, window: time.Hour, buckets: map[string]*uploadCounter{}}
	user := "user-window-test"
	lessonID := "lesson-window-test"
	key := "lessons/" + lessonID + "/student-recordings/uuid.webm"

	if !r.Allow(user, key) {
		t.Fatal("first call must succeed")
	}
	if r.Allow(user, key) {
		t.Fatal("second call within window must be rejected")
	}

	// Simulate the window having elapsed by manually rewinding the bucket's
	// reset time. We poke the limiter's internal map because that's the
	// only clock we can advance in a unit test.
	r.mu.Lock()
	bucket := uploadBucketKey(user, key)
	r.buckets[bucket].resetAt = time.Now().Add(-time.Second)
	r.mu.Unlock()

	if !r.Allow(user, key) {
		t.Fatal("rate limit must reset when the window has elapsed")
	}
}
