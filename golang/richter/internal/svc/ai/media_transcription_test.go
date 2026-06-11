package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/richter/cfg"
)

// TestWhisperSem_BlocksExcessConcurrentCalls verifies the counting
// semaphore in transcriptionService serializes the in-flight Whisper
// requests up to the configured cap. We stand up a fake Whisper
// server that sleeps 200 ms per request and records the peak
// concurrency it observes. With WhisperMaxConcurrent=1, peak must be
// exactly 1 even when 5 requests are fired in parallel. With cap=0
// (unlimited), all 5 run truly in parallel and peak must be 5.
func TestWhisperSem_BlocksExcessConcurrentCalls(t *testing.T) {
	cases := []struct {
		name        string
		cap         int
		parallelism int
		wantPeak    int32
	}{
		{"cap1_with_5", 1, 5, 1},
		{"cap2_with_5", 2, 5, 2},
		{"unlimited_with_5", 0, 5, 5},
		{"cap5_with_3", 5, 3, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var inFlight int32
			var peakInFlight int32
			var total int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				now := atomic.AddInt32(&inFlight, 1)
				defer atomic.AddInt32(&inFlight, -1)
				// Track the high-water mark across the whole test run.
				for {
					old := atomic.LoadInt32(&peakInFlight)
					if now <= old || atomic.CompareAndSwapInt32(&peakInFlight, old, now) {
						break
					}
				}
				atomic.AddInt32(&total, 1)
				time.Sleep(200 * time.Millisecond)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"text":     "hello",
					"segments": []map[string]any{{"start": 0.0, "end": 1.0, "text": "hello"}},
				})
			}))
			defer srv.Close()

			// Endpoint is "host:port" — parse from the test server URL.
			endpoint := strings.TrimPrefix(srv.URL, "http://")
			ai := cfg.NewAiCfg()
			ai.WhisperMaxConcurrent = tc.cap
			// Don't let internal timeouts cut our test off.
			ai.WhisperClientTimeout = 10 * time.Second
			ai.WhisperResponseHeaderTimeout = 10 * time.Second
			ai.WhisperRequestTimeout = 10 * time.Second
			whisper := cfg.NewWhisperCfg()
			whisper.Endpoint = endpoint
			svc := newTranscriptionService(nil, nil, &whisper, &ai)

			// whisperTranscribe now streams the WAV from a temp file path
			// (no longer takes an in-memory []byte), so write a dummy file.
			audioPath := filepath.Join(t.TempDir(), "audio.wav")
			if err := os.WriteFile(audioPath, []byte("audio"), 0o600); err != nil {
				t.Fatalf("write temp audio: %v", err)
			}

			var wg sync.WaitGroup
			wg.Add(tc.parallelism)
			start := time.Now()
			for i := 0; i < tc.parallelism; i++ {
				go func() {
					defer wg.Done()
					_, _, err := svc.whisperTranscribe(context.Background(), audioPath)
					if err != nil {
						t.Errorf("whisperTranscribe: %v", err)
					}
				}()
			}
			wg.Wait()
			elapsed := time.Since(start)
			gotPeak := atomic.LoadInt32(&peakInFlight)
			if gotPeak != tc.wantPeak {
				t.Errorf("peak in-flight = %d, want %d (cap=%d parallelism=%d)", gotPeak, tc.wantPeak, tc.cap, tc.parallelism)
			}
			// Sanity: serialized cap=1 with 5×200ms must take ≥ 1s.
			if tc.cap == 1 && tc.parallelism == 5 && elapsed < 900*time.Millisecond {
				t.Errorf("cap=1 with 5 parallel: elapsed = %v, want ≥ 1s (semaphore didn't serialize)", elapsed)
			}
		})
	}
}

// TestWhisperSem_CtxCancelUnblocks verifies that a waiter on the
// semaphore unblocks with ctx.Err() when its context is cancelled
// before a slot frees up. This protects against workers hanging on
// Whisper indefinitely when their parent context is cancelled
// (e.g. lesson task cancel).
func TestWhisperSem_CtxCancelUnblocks(t *testing.T) {
	var inFlight int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&inFlight, 1)
		defer atomic.AddInt32(&inFlight, -1)
		time.Sleep(500 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"text": "x", "segments": []any{}})
	}))
	defer srv.Close()
	ai := cfg.NewAiCfg()
	ai.WhisperMaxConcurrent = 1
	ai.WhisperClientTimeout = 5 * time.Second
	ai.WhisperResponseHeaderTimeout = 5 * time.Second
	ai.WhisperRequestTimeout = 5 * time.Second
	whisper := cfg.NewWhisperCfg()
	whisper.Endpoint = strings.TrimPrefix(srv.URL, "http://")
	svc := newTranscriptionService(nil, nil, &whisper, &ai)

	audioPath := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(audioPath, []byte("a"), 0o600); err != nil {
		t.Fatalf("write temp audio: %v", err)
	}

	// Saturate the slot.
	saturationDone := make(chan struct{})
	go func() {
		_, _, _ = svc.whisperTranscribe(context.Background(), audioPath)
		close(saturationDone)
	}()
	// Give the first request a moment to enter the semaphore.
	for atomic.LoadInt32(&inFlight) == 0 {
		time.Sleep(5 * time.Millisecond)
	}

	// Now a second request must block on the semaphore. Cancel its
	// context and expect an error back within ~50 ms (not 500 ms).
	ctx, cancel := context.WithCancel(context.Background())
	waitStart := time.Now()
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, _, err := svc.whisperTranscribe(ctx, audioPath)
	waitElapsed := time.Since(waitStart)
	if err == nil {
		t.Fatal("expected error from cancelled-ctx whisper, got nil")
	}
	if !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("err = %v, want context canceled", err)
	}
	if waitElapsed > 200*time.Millisecond {
		t.Errorf("cancelled ctx waited %v, want ≤ 200ms (semaphore didn't respect ctx)", waitElapsed)
	}
	// Wait for the first request to finish so we don't leak the goroutine.
	<-saturationDone
}

// TestWhisperSem_NilUnlimited verifies that an unconfigured (cap<=0)
// transcriptionService has no semaphore and allows truly unbounded
// parallel calls. (Sanity test for the "0 = unlimited" semantics.)
func TestWhisperSem_NilUnlimited(t *testing.T) {
	ai := cfg.NewAiCfg()
	ai.WhisperMaxConcurrent = 0
	whisper := cfg.NewWhisperCfg()
	svc := newTranscriptionService(nil, nil, &whisper, &ai)
	if svc.whisperSem != nil {
		t.Fatalf("whisperSem must be nil when WhisperMaxConcurrent <= 0, got non-nil")
	}
}
