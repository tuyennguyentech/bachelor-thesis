package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal/svc/ai/genengine"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/richter/internal/taskqueue"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
)

// hasVietnameseDiacritics reports whether s contains characters specific to
// Vietnamese (đ + the vowels with Vietnamese diacritics). Used to assert a
// generated chunk summary is in the requested language, not always Vietnamese.
func hasVietnameseDiacritics(s string) bool {
	for _, r := range strings.ToLower(s) {
		switch r {
		case 'đ', 'ă', 'â', 'ê', 'ô', 'ơ', 'ư',
			'á', 'à', 'ả', 'ã', 'ạ', 'ấ', 'ầ', 'ẩ', 'ẫ', 'ậ', 'ắ', 'ằ', 'ẳ', 'ẵ', 'ặ',
			'é', 'è', 'ẻ', 'ẽ', 'ẹ', 'ế', 'ề', 'ể', 'ễ', 'ệ',
			'í', 'ì', 'ỉ', 'ĩ', 'ị',
			'ó', 'ò', 'ỏ', 'õ', 'ọ', 'ố', 'ồ', 'ổ', 'ỗ', 'ộ', 'ớ', 'ờ', 'ở', 'ỡ', 'ợ',
			'ú', 'ù', 'ủ', 'ũ', 'ụ', 'ứ', 'ừ', 'ử', 'ữ', 'ự',
			'ý', 'ỳ', 'ỷ', 'ỹ', 'ỵ':
			return true
		}
	}
	return false
}

// fakeChunkEngine fails its first `failTimes` Generate calls (with failErr) then
// returns `okResp`, recording the total number of calls. Used to exercise the
// chunk-stage transient-retry policy without touching the real Gemini API.
type fakeChunkEngine struct {
	calls      int
	failTimes  int
	failErr    error
	okResp     string
	lastPrompt string
}

func (f *fakeChunkEngine) Name() string { return "fake" }

func (f *fakeChunkEngine) Generate(_ context.Context, req genengine.Request) (string, error) {
	f.calls++
	f.lastPrompt = req.Prompt
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
		chunks, err := mkSvc(eng, 4).runGeminiChunk(context.Background(), "nội dung transcript", nil, "vi")
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
		_, err := mkSvc(eng, 3).runGeminiChunk(context.Background(), "t", nil, "vi")
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
		_, err := mkSvc(eng, 4).runGeminiChunk(context.Background(), "t", nil, "vi")
		if err == nil {
			t.Fatal("want error")
		}
		if eng.calls != 1 {
			t.Errorf("non-transient error must fail fast; want 1 call, got %d", eng.calls)
		}
	})

	t.Run("chunk prompt instructs the summary language", func(t *testing.T) {
		// en → the prompt must tell Gemini to write the summary in English, so
		// chunk names follow the lesson language instead of always Vietnamese.
		engEN := &fakeChunkEngine{okResp: okResp}
		if _, err := mkSvc(engEN, 1).runGeminiChunk(context.Background(), "transcript", nil, "en"); err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if !strings.Contains(engEN.lastPrompt, "Tiếng Anh (English)") {
			t.Errorf("en prompt should request an English summary; prompt did not mention it")
		}
		if strings.Contains(engEN.lastPrompt, "Tiếng Việt (Vietnamese)") {
			t.Errorf("en prompt should not request a Vietnamese summary")
		}

		engVI := &fakeChunkEngine{okResp: okResp}
		if _, err := mkSvc(engVI, 1).runGeminiChunk(context.Background(), "transcript", nil, "vi"); err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if !strings.Contains(engVI.lastPrompt, "Tiếng Việt (Vietnamese)") {
			t.Errorf("vi prompt should request a Vietnamese summary")
		}
	})
}

// TestChunkSummaryLanguageRealGemini is a GATED real-API test (skips unless
// RICHTER_GEMINI_API_KEY is set). It proves the P3 fix end-to-end against the
// real model: an English transcript with language="en" yields an English chunk
// summary (no Vietnamese diacritics), instead of the old always-Vietnamese name.
func TestChunkSummaryLanguageRealGemini(t *testing.T) {
	key := os.Getenv("RICHTER_GEMINI_API_KEY")
	if key == "" {
		t.Skip("RICHTER_GEMINI_API_KEY not set — skipping real Gemini integration test")
	}
	model := os.Getenv("RICHTER_GEMINI_MODEL")
	if model == "" {
		model = "gemini-3.1-flash-lite"
	}
	aiCfg := cfg.NewAiCfg()
	s := &chunkingService{
		aiCfg:  &aiCfg,
		engine: genengine.NewGemini(&cfg.GeminiCfg{APIKey: key, Model: model}),
		log:    discardLog(),
	}

	const englishTranscript = `What is an algorithm? In computer science, an algorithm is a ` +
		`set of step-by-step instructions for solving a problem. Computers run algorithms, ` +
		`but humans use them too. For example, to count the people in a room you might point ` +
		`at each person one at a time and count up from zero. That counting procedure is an ` +
		`algorithm. A more efficient algorithm counts people two at a time, which roughly ` +
		`halves the number of steps. Choosing a better algorithm makes the same task faster.`

	chunks, err := s.runGeminiChunk(context.Background(), englishTranscript, nil, "en")
	if err != nil {
		if isTransientGeminiError(err) {
			t.Skipf("real Gemini quota/transient error, skipping: %v", err)
		}
		t.Fatalf("runGeminiChunk(en): %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one chunk")
	}
	for i, c := range chunks {
		t.Logf("en chunk %d summary: %q", i, c.Summary)
		if strings.TrimSpace(c.Summary) == "" {
			t.Errorf("chunk %d has empty summary", i)
		}
		if hasVietnameseDiacritics(c.Summary) {
			t.Errorf("chunk %d summary %q contains Vietnamese diacritics — should be English for language=en", i, c.Summary)
		}
	}
}

// TestListeningGenerationRealGemini is a GATED real-API test (skips unless
// RICHTER_GEMINI_API_KEY is set). It proves the single-MCQ model end-to-end
// against the real model: a listening item generated from a real transcript
// yields ONE question (synthesised to audio) with exactly 4 options + a valid
// correct_answer — no passage, no multi-question list. Exercises the real
// listening prompt + schema + ParseGeminiItem validation.
func TestListeningGenerationRealGemini(t *testing.T) {
	key := os.Getenv("RICHTER_GEMINI_API_KEY")
	if key == "" {
		t.Skip("RICHTER_GEMINI_API_KEY not set — skipping real Gemini integration test")
	}
	model := os.Getenv("RICHTER_GEMINI_MODEL")
	if model == "" {
		model = "gemini-3.1-flash-lite"
	}
	g, ok := svcinteractions.Get(richterv1.InteractionKind_INTERACTION_KIND_LISTENING).(svcinteractions.GeminiGenerator)
	if !ok {
		t.Fatal("listening handler is not a GeminiGenerator")
	}
	tts, ok := g.(svcinteractions.TTSProvider)
	if !ok {
		t.Fatal("listening handler is not a TTSProvider")
	}
	eng := genengine.NewGemini(&cfg.GeminiCfg{APIKey: key, Model: model})

	const transcript = `What is an algorithm? In computer science, an algorithm is a set of ` +
		`step-by-step instructions for solving a problem. For example, to count the number of ` +
		`people in a room, you could point at each person one at a time and count up from zero. ` +
		`A more efficient algorithm counts people two at a time, halving the number of steps. ` +
		`The choice of algorithm determines how quickly the same problem is solved.`

	// Mirror the real listening prompt assembly (generation/items.go): the
	// kind hint + the language instruction (strongLanguageInstruction) + the
	// transcript context + the kind's JSON schema.
	const langInstruction = "BẮT BUỘC SỬ DỤNG TIẾNG ANH cho câu hỏi, phương án và giải thích. KHÔNG viết tiếng Việt."
	prompt := fmt.Sprintf(`Bạn là chuyên gia thiết kế câu hỏi giáo dục. Tạo 1 bài tập nghe hiểu CHẤT LƯỢNG CAO từ đoạn bài giảng dưới đây.

%s
%s

Đoạn nội dung:
%s

Mỗi item trong mảng "items" phải tuân theo JSON schema sau:
%s

Trả về JSON object: {"items": [...]}`, g.GeminiPromptHint(), langInstruction, transcript, g.GeminiSchema())

	raw, err := eng.Generate(context.Background(), genengine.Request{
		Prompt:          prompt,
		Temperature:     0.3,
		MaxOutputTokens: 65536,
		JSONOutput:      true,
		Purpose:         genengine.ItemsPurpose("listening"),
	})
	if err != nil {
		if isTransientGeminiError(err) {
			t.Skipf("real Gemini quota/transient error, skipping: %v", err)
		}
		t.Fatalf("Generate(listening): %v", err)
	}

	var result struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("parse gemini response: %v\nraw: %s", err, raw)
	}
	if len(result.Items) == 0 {
		t.Fatal("expected at least one listening item")
	}

	for i, item := range result.Items {
		_, _, _, configJSON, perr := g.ParseGeminiItem(item)
		if perr != nil {
			// A rejection here is acceptable (the retry loop would re-request);
			// a malformed item is the only hard failure.
			t.Logf("item %d rejected by validation (acceptable): %v", i, perr)
			continue
		}
		// The QUESTION is the audio source now (TTS'd by AISvc later).
		question := tts.AudioSourceText(configJSON)
		words := len(strings.Fields(question))
		t.Logf("listening item %d question: %d words, vietnamese=%v — %q", i, words, hasVietnameseDiacritics(question), question)
		// HARD checks — single-MCQ model: a non-trivial spoken question + exactly
		// ONE comprehension question with 4 options.
		if words < 4 {
			t.Errorf("listening question %d has only %d words, want >= 4", i, words)
		}
		var cfg struct {
			ComprehensionQuestions []struct {
				Options []string `json:"options"`
			} `json:"comprehension_questions"`
		}
		if err := json.Unmarshal(configJSON, &cfg); err != nil {
			t.Errorf("item %d: unmarshal config: %v", i, err)
			continue
		}
		if len(cfg.ComprehensionQuestions) != 1 {
			t.Errorf("item %d: want exactly 1 comprehension question, got %d", i, len(cfg.ComprehensionQuestions))
		} else if len(cfg.ComprehensionQuestions[0].Options) != 4 {
			t.Errorf("item %d: want 4 options, got %d", i, len(cfg.ComprehensionQuestions[0].Options))
		}
	}
}

// TestNormalizeForTTS pins the fix for "ô tri" (garbled) listening audio: math /
// CS notation must be rewritten into speakable words before it reaches Piper.
// The regression guard is structural — after normalization the spoken string must
// contain NONE of the symbols a phoneme TTS chokes on.
func TestNormalizeForTTS(t *testing.T) {
	// Symbols that produce garbled audio and must never survive normalization.
	unspeakable := []string{"(", ")", "²", "³", "ⁿ", "Θ", "Ω", "Σ", "π", "λ",
		"=", "%", "^", "_", "≤", "≥", "≈", "∞", "×", "÷", "√", "[", "]", "{", "}"}

	cases := []struct {
		name     string
		in       string
		lang     string
		wantWord []string // spoken words that must appear
		notWord  []string // substrings that must NOT appear (prose false positives)
	}{
		{
			name:     "DSA complexity notation (vi)",
			in:       "Thuật toán có độ phức tạp O(n²) trong trường hợp xấu nhất và Θ(n log n) khi tốt, với cận dưới Ω(1).",
			lang:     "vi",
			wantWord: []string{"O lớn của n bình phương", "theta của n log n", "omega của 1"},
		},
		{
			name:     "recurrence + modulo (vi)",
			in:       "Công thức truy hồi T(n) = aT(n/b) + f(n); và 7 % 2 = 1.",
			lang:     "vi",
			wantWord: []string{"bằng", "phần trăm"},
		},
		{
			name:     "english audio",
			in:       "The cost is O(n²) and at most Θ(n log n); 3 ≤ x ≤ 5.",
			lang:     "en",
			wantWord: []string{"Big O of n squared", "theta of n log n", "less than or equal to"},
		},
		{
			name:     "plain prose untouched",
			in:       "Hôm nay chúng ta học về danh sách liên kết và cây nhị phân.",
			lang:     "vi",
			wantWord: []string{"danh sách liên kết", "cây nhị phân"},
		},
		{
			// A lowercase-o word before " (" must NOT be read as Big-O, and a "/"
			// in a date/URL must NOT become "trên" (the false positives we just fixed).
			name:    "prose with parens + date is not mangled",
			in:      "Tất cả vào (xem hình 3) trong buổi ngày 20/6 đều đúng.",
			lang:    "vi",
			notWord: []string{"O lớn", "lớn của", "trên"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeForTTS(tc.in, tc.lang)
			for _, sym := range unspeakable {
				if strings.Contains(got, sym) {
					t.Errorf("normalized text still contains unspeakable %q: %q", sym, got)
				}
			}
			for _, w := range tc.wantWord {
				if !strings.Contains(got, w) {
					t.Errorf("normalized text missing expected words %q: got %q", w, got)
				}
			}
			for _, w := range tc.notWord {
				if strings.Contains(got, w) {
					t.Errorf("normalized text has false-positive %q: got %q", w, got)
				}
			}
		})
	}

	// Clean prose with no notation must pass through byte-for-byte.
	clean := "Buổi học hôm nay nói về cấu trúc dữ liệu và các ứng dụng thực tế."
	if got := normalizeForTTS(clean, "vi"); got != clean {
		t.Errorf("clean prose was altered:\n want %q\n  got %q", clean, got)
	}
}
