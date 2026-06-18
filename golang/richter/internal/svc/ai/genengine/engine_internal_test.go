package genengine

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/richter/cfg"
)

// TestGeminiConcurrencyCap proves the process-wide semaphore actually bounds the
// number of concurrent in-flight calls to gemini.max_concurrent — the fix for
// the quota retry-storm that stalled generation when several quick-create
// pipelines ran at once. Tested via acquireSlot (no real API key needed).
func TestGeminiConcurrencyCap(t *testing.T) {
	t.Parallel()

	const cap = 2
	e := NewGemini(&cfg.GeminiCfg{MaxConcurrent: cap}).(*geminiEngine)

	var inFlight, maxSeen int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := e.acquireSlot(context.Background())
			if err != nil {
				t.Errorf("acquireSlot: %v", err)
				return
			}
			cur := atomic.AddInt32(&inFlight, 1)
			for {
				old := atomic.LoadInt32(&maxSeen)
				if cur <= old || atomic.CompareAndSwapInt32(&maxSeen, old, cur) {
					break
				}
			}
			time.Sleep(5 * time.Millisecond) // hold the slot so contention is real
			atomic.AddInt32(&inFlight, -1)
			release()
		}()
	}
	wg.Wait()

	if maxSeen > cap {
		t.Errorf("concurrency exceeded the cap: saw %d concurrent, cap is %d", maxSeen, cap)
	}
	if maxSeen == 0 {
		t.Error("expected some concurrency, saw none")
	}
}

// TestGeminiNoCapIsUnlimited verifies MaxConcurrent=0 disables the semaphore
// (acquireSlot is a no-op) so the mock/test path and unconfigured deployments
// are never throttled.
func TestGeminiNoCapIsUnlimited(t *testing.T) {
	t.Parallel()
	e := NewGemini(&cfg.GeminiCfg{MaxConcurrent: 0}).(*geminiEngine)
	if e.sem != nil {
		t.Fatal("expected nil semaphore when MaxConcurrent=0")
	}
	// acquireSlot returns immediately with a no-op release.
	release, err := e.acquireSlot(context.Background())
	if err != nil {
		t.Fatalf("acquireSlot with no cap: err=%v", err)
	}
	if release == nil {
		t.Fatal("acquireSlot with no cap returned a nil release")
	}
	release()
}
