package ai

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/internal/svc/ai/genengine"
	"example.com/richter/internal/taskqueue"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
)

// fakeChunkEngine fails its first `failTimes` Generate calls (with failErr) then
// returns `okResp`, recording the total number of calls. Used to exercise the
// chunk-stage transient-retry policy without touching the real Gemini API.
type fakeChunkEngine struct {
	calls     int
	failTimes int
	failErr   error
	okResp    string
}

func (f *fakeChunkEngine) Name() string { return "fake" }

func (f *fakeChunkEngine) Generate(_ context.Context, _ genengine.Request) (string, error) {
	f.calls++
	if f.calls <= f.failTimes {
		return "", f.failErr
	}
	return f.okResp, nil
}

// mockTTS is a TTSSynthesizer that fails its first `failTimes` calls (with
// failErr) then succeeds, recording the total number of calls.
type mockTTS struct {
	calls     int
	failTimes int
	failErr   error
}

func (m *mockTTS) Synthesise(_ context.Context, _, _ string) ([]byte, error) {
	m.calls++
	if m.calls <= m.failTimes {
		return nil, m.failErr
	}
	return []byte("WAV"), nil
}

func discardLog() *log.LogSvc {
	return &log.LogSvc{Logger: *slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// TestAnalysisLocks_SerializesSameLesson verifies the per-lesson analysis lock
// actually prevents two callers from running concurrently for the same lesson,
// while allowing parallel execution for different lessons.
func TestAnalysisLocks_SerializesSameLesson(t *testing.T) {
	const lessonID = "test-lesson-serial"
	analysisLocks = newAnalysisLockRegistry()
	lock, ok := analysisLocks.tryAcquire(lessonID)
	if !ok {
		t.Fatal("first TryLock must succeed on a fresh lock")
	}

	// Second TryLock on the same lesson should fail.
	if _, ok := analysisLocks.tryAcquire(lessonID); ok {
		t.Fatal("second TryLock on the same lesson must fail while first is held")
	}
	analysisLocks.release(lessonID, lock)

	// A different lesson has its own lock and is unaffected.
	const otherLessonID = "test-lesson-other"
	other, ok := analysisLocks.tryAcquire(otherLessonID)
	if !ok {
		t.Fatal("first TryLock on a different lesson must succeed")
	}
	analysisLocks.release(otherLessonID, other)
	if got := analysisLocks.len(); got != 0 {
		t.Fatalf("analysis lock registry leaked %d entries", got)
	}
}

// TestAnalysisLocks_ParallelLessonsContended is a stress test: spawn N
// goroutines that all try to lock the SAME lesson and check that at most one
// holds it at any moment.
func TestAnalysisLocks_ParallelLessonsContended(t *testing.T) {
	const lessonID = "test-lesson-contention"
	const workers = 50
	const itersPerWorker = 100

	analysisLocks = newAnalysisLockRegistry()

	var holders int32
	var peak int32
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < itersPerWorker; j++ {
				var lock *analysisLockEntry
				for {
					var ok bool
					lock, ok = analysisLocks.tryAcquire(lessonID)
					if ok {
						break
					}
					time.Sleep(time.Microsecond)
				}
				now := atomic.AddInt32(&holders, 1)
				for {
					p := atomic.LoadInt32(&peak)
					if now <= p || atomic.CompareAndSwapInt32(&peak, p, now) {
						break
					}
				}
				if now != 1 {
					t.Errorf("lock held by %d goroutines concurrently", now)
				}
				time.Sleep(time.Microsecond)
				atomic.AddInt32(&holders, -1)
				analysisLocks.release(lessonID, lock)
			}
		}()
	}
	wg.Wait()
	if peak > 1 {
		t.Errorf("peak concurrent holders = %d, want 1", peak)
	}
	if got := analysisLocks.len(); got != 0 {
		t.Fatalf("analysis lock registry leaked %d entries", got)
	}
}

// TestDeriveAnalysisFromTasks_PipelineRun guards the Quick-Create status fix.
// The composite pipeline_run task runs transcribe→chunk→quiz_gen inside ONE
// durable task and creates NO separate transcribe/chunk/quiz_gen rows. Before
// the fix, deriveAnalysisFromTasks ignored pipeline_run entirely, so a
// fully-generated Quick-Create lesson derived to PENDING — which made the FE
// treat it as a fresh upload and wipe the generated chunks/interactions on
// reload ("stuck at Phiên âm"). A succeeded pipeline_run must derive to DONE;
// an in-flight one to PROCESSING (NOT pending); a failed one to ERROR.
func TestDeriveAnalysisFromTasks_PipelineRun(t *testing.T) {
	t.Parallel()
	var lessonID pgtype.UUID
	cases := []struct {
		name  string
		tasks []taskqueue.Task
		want  gen.LessonAnalysisStatus
	}{
		{
			name:  "succeeded pipeline_run -> done",
			tasks: []taskqueue.Task{{TaskType: "pipeline_run", Status: string(taskqueue.StatusSucceeded)}},
			want:  gen.LessonAnalysisStatusDone,
		},
		{
			name:  "processing pipeline_run -> processing (not pending, keeps generated data on reload)",
			tasks: []taskqueue.Task{{TaskType: "pipeline_run", Status: string(taskqueue.StatusProcessing)}},
			want:  gen.LessonAnalysisStatusProcessing,
		},
		{
			name:  "inqueued pipeline_run -> processing",
			tasks: []taskqueue.Task{{TaskType: "pipeline_run", Status: string(taskqueue.StatusInqueued)}},
			want:  gen.LessonAnalysisStatusProcessing,
		},
		{
			name:  "failed pipeline_run -> error",
			tasks: []taskqueue.Task{{TaskType: "pipeline_run", Status: string(taskqueue.StatusFailed)}},
			want:  gen.LessonAnalysisStatusError,
		},
		{
			name: "legacy transcribe+chunk+quiz_gen path still resolves to done",
			tasks: []taskqueue.Task{
				{TaskType: "transcribe", Status: string(taskqueue.StatusSucceeded)},
				{TaskType: "chunk", Status: string(taskqueue.StatusSucceeded)},
				{TaskType: "quiz_gen", Status: string(taskqueue.StatusSucceeded)},
			},
			want: gen.LessonAnalysisStatusDone,
		},
		{
			name:  "no tasks -> pending default",
			tasks: nil,
			want:  gen.LessonAnalysisStatusPending,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := deriveAnalysisFromTasks(lessonID, tc.tasks); got.Status != tc.want {
				t.Errorf("deriveAnalysisFromTasks status = %q, want %q", got.Status, tc.want)
			}
		})
	}
}

// TestApplyArtifactFloor guards the processing-tab reload bug: a lesson that
// already has chunks/interactions must derive a stable DONE/CHUNKS_READY status
// (so the FE never wipes real data or flips the stepper between steps 3/4),
// while an active failure/re-run still surfaces its in-flight state.
func TestApplyArtifactFloor(t *testing.T) {
	t.Parallel()
	succ := string(taskqueue.StatusSucceeded)
	now := time.Unix(1_700_000_000, 0)
	fresh := pgtype.Timestamptz{Time: now.Add(-5 * time.Second), Valid: true}  // live worker
	stale := pgtype.Timestamptz{Time: now.Add(-10 * time.Minute), Valid: true} // dead worker
	cases := []struct {
		name            string
		status          gen.LessonAnalysisStatus
		latest          []taskqueue.Task
		hasChunks       bool
		hasInteractions bool
		want            gen.LessonAnalysisStatus
	}{
		{
			name:            "chunks ready + per-chunk interactions (no quiz_gen task) -> DONE",
			status:          gen.LessonAnalysisStatusChunksReady,
			latest:          []taskqueue.Task{{TaskType: "transcribe", Status: succ}, {TaskType: "chunk", Status: succ}},
			hasChunks:       true,
			hasInteractions: true,
			want:            gen.LessonAnalysisStatusDone,
		},
		{
			name:            "latest chunk cancelled but interactions exist -> DONE (cancelled isn't failed/in-flight)",
			status:          gen.LessonAnalysisStatusPending,
			latest:          []taskqueue.Task{{TaskType: "chunk", Status: string(taskqueue.StatusCancelled)}},
			hasChunks:       true,
			hasInteractions: true,
			want:            gen.LessonAnalysisStatusDone,
		},
		{
			name:            "chunks but no interactions -> floor to CHUNKS_READY",
			status:          gen.LessonAnalysisStatusTranscriptExtracted,
			latest:          []taskqueue.Task{{TaskType: "transcribe", Status: succ}},
			hasChunks:       true,
			hasInteractions: false,
			want:            gen.LessonAnalysisStatusChunksReady,
		},
		{
			name:            "interactions exist but a stage FAILED -> keep derived status (surface the error)",
			status:          gen.LessonAnalysisStatusError,
			latest:          []taskqueue.Task{{TaskType: "chunk", Status: string(taskqueue.StatusFailed)}},
			hasChunks:       true,
			hasInteractions: true,
			want:            gen.LessonAnalysisStatusError,
		},
		{
			name:            "interactions exist but a LIVE re-run is in flight (fresh heartbeat) -> keep PROCESSING",
			status:          gen.LessonAnalysisStatusProcessing,
			latest:          []taskqueue.Task{{TaskType: "chunk", Status: string(taskqueue.StatusProcessing), Heartbeat: fresh}},
			hasChunks:       true,
			hasInteractions: true,
			want:            gen.LessonAnalysisStatusProcessing,
		},
		{
			name:            "processing task with STALE heartbeat (dead worker) + interactions -> floor to DONE",
			status:          gen.LessonAnalysisStatusProcessing,
			latest:          []taskqueue.Task{{TaskType: "pipeline_run", Status: string(taskqueue.StatusProcessing), Heartbeat: stale}},
			hasChunks:       true,
			hasInteractions: true,
			want:            gen.LessonAnalysisStatusDone,
		},
		{
			name:            "no artifacts -> status unchanged",
			status:          gen.LessonAnalysisStatusPending,
			latest:          []taskqueue.Task{{TaskType: "transcribe", Status: succ}},
			hasChunks:       false,
			hasInteractions: false,
			want:            gen.LessonAnalysisStatusPending,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := applyArtifactFloor(now, c.status, c.latest, c.hasChunks, c.hasInteractions)
			if got != c.want {
				t.Errorf("applyArtifactFloor: want %v, got %v", c.want, got)
			}
		})
	}
}

// TestSynthesiseWithRetry guards the listening/TTS fix: a transient TTS failure
// must be RETRIED (not silently drop the listening question for that chunk).
func TestSynthesiseWithRetry(t *testing.T) {
	t.Parallel()
	mkSvc := func(mock *mockTTS) *AISvc {
		return &AISvc{
			ttsClient: mock,
			log:       discardLog(),
			aiCfg:     &cfg.AiCfg{TTSMaxAttempts: 3, TTSRetryBackoff: 0, TTSRequestTimeout: 0},
		}
	}

	t.Run("recovers after transient failures", func(t *testing.T) {
		mock := &mockTTS{failTimes: 2, failErr: errors.New("speaches 503")}
		wav, err := mkSvc(mock).synthesiseWithRetry(context.Background(), "xin chào", "vi")
		if err != nil {
			t.Fatalf("want success after retries, got err: %v", err)
		}
		if string(wav) != "WAV" {
			t.Errorf("want WAV bytes, got %q", wav)
		}
		if mock.calls != 3 {
			t.Errorf("want 3 attempts (2 fail + 1 success), got %d", mock.calls)
		}
	})

	t.Run("succeeds on first try without retry", func(t *testing.T) {
		mock := &mockTTS{failTimes: 0}
		if _, err := mkSvc(mock).synthesiseWithRetry(context.Background(), "hi", "en"); err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if mock.calls != 1 {
			t.Errorf("want 1 attempt, got %d", mock.calls)
		}
	})

	t.Run("gives up after TTSMaxAttempts when TTS keeps failing", func(t *testing.T) {
		mock := &mockTTS{failTimes: 99, failErr: errors.New("speaches down")}
		_, err := mkSvc(mock).synthesiseWithRetry(context.Background(), "hi", "vi")
		if err == nil {
			t.Fatal("want error after exhausting attempts")
		}
		if mock.calls != 3 {
			t.Errorf("want exactly 3 attempts (TTSMaxAttempts), got %d", mock.calls)
		}
	})
}

// TestChunkStageRetriesTransient covers the fix for the "Không thể phân đoạn"
// pipeline failure: the chunk stage must retry transient Gemini errors (429
// quota, 5xx) with backoff — like item generation already does — so a momentary
// quota blip under concurrent pipelines no longer kills the whole pipeline.
func TestChunkStageRetriesTransient(t *testing.T) {
	t.Parallel()
	const okResp = `{"chunks":[{"summary":"Đoạn mẫu","start_seconds":0,"end_seconds":7}]}`
	// GeminiRetryBackoff=0 keeps the test instant; ChunkingTimeout=0 = unlimited.
	mkSvc := func(eng genengine.Engine, attempts int) *chunkingService {
		return &chunkingService{
			aiCfg:  &cfg.AiCfg{GeminiMaxAttempts: attempts, GeminiRetryBackoff: 0, ChunkingTimeout: 0},
			engine: eng,
			log:    discardLog(),
		}
	}

	t.Run("retries a transient 429 then succeeds", func(t *testing.T) {
		eng := &fakeChunkEngine{failTimes: 2, failErr: errors.New("googleapi: Error 429: RESOURCE_EXHAUSTED"), okResp: okResp}
		chunks, err := mkSvc(eng, 4).runGeminiChunk(context.Background(), "nội dung transcript", nil)
		if err != nil {
			t.Fatalf("want success after retries, got err: %v", err)
		}
		if len(chunks) != 1 {
			t.Errorf("want 1 chunk, got %d", len(chunks))
		}
		if eng.calls != 3 {
			t.Errorf("want 3 calls (2 transient fails + 1 success), got %d", eng.calls)
		}
	})

	t.Run("gives up after GeminiMaxAttempts with a friendly quota message", func(t *testing.T) {
		eng := &fakeChunkEngine{failTimes: 99, failErr: errors.New("Error 429: quota exceeded"), okResp: okResp}
		_, err := mkSvc(eng, 3).runGeminiChunk(context.Background(), "t", nil)
		if err == nil {
			t.Fatal("want error after exhausting attempts")
		}
		if eng.calls != 3 {
			t.Errorf("want exactly 3 attempts (GeminiMaxAttempts), got %d", eng.calls)
		}
		if !strings.Contains(err.Error(), "Vượt hạn mức") {
			t.Errorf("want friendly quota message, got %q", err.Error())
		}
	})

	t.Run("does NOT retry a non-transient error", func(t *testing.T) {
		eng := &fakeChunkEngine{failTimes: 99, failErr: errors.New("invalid request: malformed prompt"), okResp: okResp}
		_, err := mkSvc(eng, 4).runGeminiChunk(context.Background(), "t", nil)
		if err == nil {
			t.Fatal("want error")
		}
		if eng.calls != 1 {
			t.Errorf("non-transient error must fail fast; want 1 call, got %d", eng.calls)
		}
	})
}
