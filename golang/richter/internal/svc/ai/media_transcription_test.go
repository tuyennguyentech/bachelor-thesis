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

// TestSTTSem_BlocksExcessConcurrentCalls verifies the counting
// semaphore in transcriptionService serializes the in-flight STT
// requests up to the configured cap. We stand up a fake STT
// server that sleeps 200 ms per request and records the peak
// concurrency it observes. With STTMaxConcurrent=1, peak must be
// exactly 1 even when 5 requests are fired in parallel. With cap=0
// (unlimited), all 5 run truly in parallel and peak must be 5.
func TestSTTSem_BlocksExcessConcurrentCalls(t *testing.T) {
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
			ai.STTMaxConcurrent = tc.cap
			// Don't let internal timeouts cut our test off.
			ai.STTClientTimeout = 10 * time.Second
			ai.STTResponseHeaderTimeout = 10 * time.Second
			ai.STTRequestTimeout = 10 * time.Second
			stt := cfg.NewSTTCfg()
			stt.Endpoint = endpoint
			svc := newTranscriptionService(nil, nil, &stt, &ai)

			// sttTranscribe now streams the WAV from a temp file path
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
					_, _, err := svc.sttTranscribe(context.Background(), audioPath, "")
					if err != nil {
						t.Errorf("sttTranscribe: %v", err)
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

// TestSTTSem_CtxCancelUnblocks verifies that a waiter on the
// semaphore unblocks with ctx.Err() when its context is cancelled
// before a slot frees up. This protects against workers hanging on
// STT indefinitely when their parent context is cancelled
// (e.g. lesson task cancel).
func TestSTTSem_CtxCancelUnblocks(t *testing.T) {
	var inFlight int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&inFlight, 1)
		defer atomic.AddInt32(&inFlight, -1)
		time.Sleep(500 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"text": "x", "segments": []any{}})
	}))
	defer srv.Close()
	ai := cfg.NewAiCfg()
	ai.STTMaxConcurrent = 1
	ai.STTClientTimeout = 5 * time.Second
	ai.STTResponseHeaderTimeout = 5 * time.Second
	ai.STTRequestTimeout = 5 * time.Second
	stt := cfg.NewSTTCfg()
	stt.Endpoint = strings.TrimPrefix(srv.URL, "http://")
	svc := newTranscriptionService(nil, nil, &stt, &ai)

	audioPath := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(audioPath, []byte("a"), 0o600); err != nil {
		t.Fatalf("write temp audio: %v", err)
	}

	// Saturate the slot.
	saturationDone := make(chan struct{})
	go func() {
		_, _, _ = svc.sttTranscribe(context.Background(), audioPath, "")
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
	_, _, err := svc.sttTranscribe(ctx, audioPath, "")
	waitElapsed := time.Since(waitStart)
	if err == nil {
		t.Fatal("expected error from cancelled-ctx STT, got nil")
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

// TestSTTLanguageHint verifies the SPOKEN-language hint sent to Whisper as the
// "language" multipart field. PRECEDENCE: the per-lesson audio language (passed
// to sttTranscribe) wins; otherwise the deployment default (sttCfg.Language);
// empty/whitespace on both => the field is omitted (Whisper auto-detect). This
// is the audio language — independent of the lesson's output/exercise language —
// and is what keeps a Vietnamese clip from being read as English AND an English
// clip from being forced to Vietnamese.
func TestSTTLanguageHint(t *testing.T) {
	cases := []struct {
		name      string
		perLesson string // audioLang argument (per-lesson)
		cfgLang   string // sttCfg.Language (deployment default)
		wantSent  string // "" => the field must be ABSENT (auto-detect)
	}{
		{"per_lesson_vi", "vi", "", "vi"},
		{"per_lesson_overrides_cfg", "en", "vi", "en"}, // EN video on a vi-default deployment
		{"cfg_fallback_when_no_per_lesson", "", "vi", "vi"},
		{"both_empty_autodetect", "", "", ""},
		{"whitespace_autodetect", "  ", "  ", ""},
		{"per_lesson_trimmed", "  en ", "", "en"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var gotLang string
			var hadField bool
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseMultipartForm(1 << 20); err == nil && r.MultipartForm != nil {
					if vals, ok := r.MultipartForm.Value["language"]; ok {
						mu.Lock()
						hadField = true
						if len(vals) > 0 {
							gotLang = vals[0]
						}
						mu.Unlock()
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"text":     "xin chào",
					"segments": []map[string]any{{"start": 0.0, "end": 1.0, "text": "xin chào"}},
				})
			}))
			defer srv.Close()

			ai := cfg.NewAiCfg()
			ai.STTClientTimeout = 5 * time.Second
			ai.STTResponseHeaderTimeout = 5 * time.Second
			ai.STTRequestTimeout = 5 * time.Second
			stt := cfg.NewSTTCfg()
			stt.Endpoint = strings.TrimPrefix(srv.URL, "http://")
			stt.Language = tc.cfgLang
			svc := newTranscriptionService(nil, nil, &stt, &ai)

			audioPath := filepath.Join(t.TempDir(), "audio.wav")
			if err := os.WriteFile(audioPath, []byte("audio"), 0o600); err != nil {
				t.Fatalf("write temp audio: %v", err)
			}
			if _, _, err := svc.sttTranscribe(context.Background(), audioPath, tc.perLesson); err != nil {
				t.Fatalf("sttTranscribe: %v", err)
			}

			mu.Lock()
			defer mu.Unlock()
			if tc.wantSent == "" {
				if hadField {
					t.Errorf("language field present (%q), want ABSENT (auto-detect) for perLesson=%q cfg=%q", gotLang, tc.perLesson, tc.cfgLang)
				}
			} else {
				if !hadField {
					t.Errorf("language field absent, want %q (perLesson=%q cfg=%q)", tc.wantSent, tc.perLesson, tc.cfgLang)
				} else if gotLang != tc.wantSent {
					t.Errorf("language = %q, want %q", gotLang, tc.wantSent)
				}
			}
		})
	}
}

// TestSTTSem_NilUnlimited verifies that an unconfigured (cap<=0)
// transcriptionService has no semaphore and allows truly unbounded
// parallel calls. (Sanity test for the "0 = unlimited" semantics.)
func TestSTTSem_NilUnlimited(t *testing.T) {
	ai := cfg.NewAiCfg()
	ai.STTMaxConcurrent = 0
	stt := cfg.NewSTTCfg()
	svc := newTranscriptionService(nil, nil, &stt, &ai)
	if svc.sttSem != nil {
		t.Fatalf("sttSem must be nil when STTMaxConcurrent <= 0, got non-nil")
	}
}
