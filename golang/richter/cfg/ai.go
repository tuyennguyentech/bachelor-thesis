package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

// AiCfg groups runtime knobs for the AI service: model HTTP client
// timeouts (STT, TTS, Gemini) and per-stage context deadlines
// (download, transcribe, chunk, generate interactions, grade). All
// duration fields accept 0 to mean "unlimited" (no deadline) wherever
// that is meaningful for the underlying context. Values < 0 are clamped
// to 0 by the service layer.
type AiCfg struct {
	// STTClientTimeout is the overall HTTP timeout for a single
	// STT request (whole transcription can take minutes for long
	// videos). 0 = unlimited (caller waits indefinitely).
	STTClientTimeout time.Duration `mapstructure:"stt_client_timeout"`
	// STTIdleConnTimeout recycles idle connections to the STT
	// service. 0 = unlimited (never recycle; risk: sockets leak).
	STTIdleConnTimeout time.Duration `mapstructure:"stt_idle_conn_timeout"`
	// STTResponseHeaderTimeout bounds the time we wait for the
	// server to send headers. 0 = unlimited (STT could accept a
	// request and hang forever).
	STTResponseHeaderTimeout time.Duration `mapstructure:"stt_response_header_timeout"`
	// STTMaxIdleConnsPerHost caps the HTTP keep-alive pool size to
	// the STT service. 0 = Go default (unbounded per host).
	STTMaxIdleConnsPerHost int `mapstructure:"stt_max_idle_conns_per_host"`
	// DownloadTimeout caps how long a worker may spend pulling a
	// source video from S3 / presigned URL. 0 = unlimited.
	DownloadTimeout time.Duration `mapstructure:"download_timeout"`
	// AudioExtractTimeout caps audio extraction (ffmpeg) for a single
	// source video. 0 = unlimited.
	AudioExtractTimeout time.Duration `mapstructure:"audio_extract_timeout"`
	// STTRequestTimeout caps a single STT request, including
	// upload of the audio. With segmentation enabled (the default) this
	// bounds the transcription of ONE audio chunk, not the whole video,
	// so it can stay modest even for multi-hour videos. 0 = unlimited.
	STTRequestTimeout time.Duration `mapstructure:"stt_request_timeout"`
	// STTSegmentSeconds splits the extracted audio into chunks of
	// this many seconds, each transcribed as a separate bounded STT
	// request, then stitched back with offset timestamps. This is what
	// lets the pipeline handle arbitrarily long videos (> 1h) with
	// bounded per-request time and memory — a single 1h+ request would
	// otherwise blow past the per-request timeout and stream a huge body
	// from a non-streaming server. 0 = disable (one request for the whole
	// video; only safe for short clips). Recommended: 600 (10 min).
	STTSegmentSeconds int `mapstructure:"stt_segment_seconds"`
	// STTProgressInterval is the heartbeat cadence of the
	// "STT đang chạy, vui lòng đợi…" progress message. 0 = no
	// progress emit (worker appears stuck until completion).
	STTProgressInterval time.Duration `mapstructure:"stt_progress_interval"`
	// STTMaxConcurrent caps the number of in-flight STT
	// requests across the whole process. When > 0, the transcription
	// service acquires a token before each call and releases it on
	// completion. Excess callers block. This protects the STT
	// server (speaches) from being overwhelmed by N workers hitting it
	// at once — the most common cause of "timeout awaiting response
	// headers" failures under parallel transcribe. 0 = unlimited
	// (rely on worker count only). Recommended: 1 for the default
	// speaches deployment since it serializes model inference.
	STTMaxConcurrent int `mapstructure:"stt_max_concurrent"`
	// TTSMaxConcurrent caps in-flight TTS requests across the whole
	// process — the same app-side semaphore idea as STTMaxConcurrent,
	// applied to the Speaches /v1/audio/speech endpoint. 0 = unlimited;
	// set > 0 to bound load on a constrained host. Override via env
	// RICHTER_AI_TTS_MAX_CONCURRENT.
	TTSMaxConcurrent int `mapstructure:"tts_max_concurrent"`
	// PipelineTimeout is the total wall-clock budget for the full
	// extract pipeline (download + ffmpeg + STT). It wraps the
	// outer context of runSTTAnalyze so a hung ffmpeg or STT
	// call cannot block a worker indefinitely past the sum of the
	// per-stage timeouts. 0 = unlimited (rely on per-stage timeouts
	// only). A generous value — e.g. DownloadTimeout +
	// AudioExtractTimeout + STTRequestTimeout + 5m buffer — is
	// appropriate for large videos.
	PipelineTimeout time.Duration `mapstructure:"pipeline_timeout"`
	// MaxVideoBytes caps the video file size that the download step
	// will accept. Uploads larger than this are rejected with a clear
	// error message so workers fail fast instead of spending download
	// + ffmpeg time on files they cannot process. 0 = use default
	// (2 GB). Override via env RICHTER_AI_MAX_VIDEO_BYTES.
	MaxVideoBytes int64 `mapstructure:"max_video_bytes"`
	// TempDir is the directory used for video and audio temp files
	// during transcription. Ops can point this at a dedicated,
	// size-bounded volume to avoid filling the system /tmp. Empty
	// string = os.TempDir() (system default).
	TempDir string `mapstructure:"temp_dir"`
	// ChunkingTimeout caps a single chunking pass (LLM call). 0 =
	// unlimited.
	ChunkingTimeout time.Duration `mapstructure:"chunking_timeout"`
	// InteractionGenTimeout caps a single interaction-generation pass
	// (LLM call, may iterate over many chunks). 0 = unlimited.
	InteractionGenTimeout time.Duration `mapstructure:"interaction_gen_timeout"`
	// TTSRequestTimeout caps a single TTS call. 0 = unlimited. Also used as the
	// backstop timeout on the TTS HTTP client (safety net for a context-less call).
	TTSRequestTimeout time.Duration `mapstructure:"tts_request_timeout"`
	// AudioGradeSTTTimeout bounds the STT call on the INTERACTIVE audio-grading
	// path (a student waiting), so it does not inherit the 30-minute per-request
	// STT timeout meant for long video transcription. 0 = unlimited.
	AudioGradeSTTTimeout time.Duration `mapstructure:"audio_grade_stt_timeout"`
	// WatchCoverageMaxRate bounds CUMULATIVE watch coverage: total marked seconds
	// <= grace + WatchCoverageMaxRate × real-seconds since first watch (anti-tamper).
	// Must exceed the max legitimate playback speed so honest fast viewers are not
	// undercounted; 4.0 covers up to 4x playback. 0 disables the limit.
	WatchCoverageMaxRate float64 `mapstructure:"watch_coverage_max_rate"`
	// WatchCoverageInitialGraceSeconds is the new-coverage budget for the very
	// first UpdateWatchProgress call on a {user,lesson}. 0 = use default (30).
	WatchCoverageInitialGraceSeconds int `mapstructure:"watch_coverage_initial_grace_seconds"`
	// GradingTimeout caps a single AI-graded attempt (Phase 3+). 0 =
	// unlimited.
	GradingTimeout time.Duration `mapstructure:"grading_timeout"`
	// BackgroundTaskTimeout caps fire-and-forget background tasks
	// (e.g. email, telemetry). 0 = unlimited.
	BackgroundTaskTimeout time.Duration `mapstructure:"background_task_timeout"`
	// ListLimitChunks bounds how many transcript chunks we fetch per
	// page when listing or loading an analysis. Large lessons with
	// hundreds of chunks are paged; 0 = use safe default (500).
	ListLimitChunks int `mapstructure:"list_limit_chunks"`
	// ListLimitInteractions bounds how many interactions we fetch per
	// page. 0 = use safe default (5000).
	ListLimitInteractions int `mapstructure:"list_limit_interactions"`
	// ListLimitLessonOps bounds generic list queries inside the AI
	// service (e.g. read entire transcript for re-chunking). 0 = use
	// safe default (10000).
	ListLimitLessonOps int `mapstructure:"list_limit_lesson_ops"`
	// GeminiMaxAttempts is the TOTAL number of times a Gemini generation call
	// is attempted when it hits a TRANSIENT condition — HTTP 429 (rate limit),
	// 503 (overloaded), 5xx, or a degraded empty result. Under real multi-user
	// load, bursts exceed the per-minute quota; retrying with backoff lets the
	// transient limit clear instead of failing the task. 0/1 = no retry.
	GeminiMaxAttempts int `mapstructure:"gemini_max_attempts"`
	// GeminiRetryBackoff is the base delay between Gemini retry attempts; the
	// nth retry waits n * GeminiRetryBackoff (linear, capped by the call's own
	// timeout). 0 = retry immediately.
	GeminiRetryBackoff time.Duration `mapstructure:"gemini_retry_backoff"`
}

// DefaultMaxVideoBytes is the default cap for video file downloads (2 GB).
// Used by the transcription service when AiCfg.MaxVideoBytes is 0.
// Ops should override via [ai] max_video_bytes in richter.*.toml or
// RICHTER_AI_MAX_VIDEO_BYTES for deployment-specific limits.
const DefaultMaxVideoBytes = int64(2 * 1024 * 1024 * 1024) // 2 GB

func NewAiCfg() AiCfg {
	return AiCfg{
		// Per-chunk budgets (segmentation is on by default): each value
		// bounds the transcription of one STTSegmentSeconds chunk, so
		// a multi-hour video is a sequence of bounded requests.
		STTClientTimeout:   30 * time.Minute,
		STTIdleConnTimeout: 90 * time.Second,
		// 0 = disabled. speaches' /v1/audio/transcriptions is NON-streaming:
		// it sends response headers only AFTER the whole chunk is
		// transcribed, so a header timeout is indistinguishable from "still
		// working" and would wrongly kill slow-but-healthy chunks. The
		// per-request STTRequestTimeout is the real bound instead.
		STTResponseHeaderTimeout: 0,
		STTMaxIdleConnsPerHost:   10,
		DownloadTimeout:          10 * time.Minute,
		// ffmpeg now decodes the whole video in one pass while segmenting;
		// a 1h+ source needs more than the old 3m. Decode is several×
		// realtime so 15m covers multi-hour videos comfortably.
		AudioExtractTimeout: 15 * time.Minute,
		STTRequestTimeout:   30 * time.Minute,
		STTSegmentSeconds:   600,
		STTProgressInterval: 20 * time.Second,
		STTMaxConcurrent:    1,
		// 0 = unlimited; override via RICHTER_AI_TTS_MAX_CONCURRENT if a host
		// needs a hard cap on concurrent Speaches TTS calls.
		TTSMaxConcurrent: 0,
		// 0 = unlimited. A fixed wall-clock budget would cap how long a
		// video can be (a 33-min budget kills a 1h+ transcription mid-way).
		// Each stage is independently bounded (DownloadTimeout,
		// AudioExtractTimeout, and per-chunk STTRequestTimeout), so no
		// single stage can hang; the pipeline simply takes as long as the
		// video legitimately needs. Set a positive value only to impose a
		// hard ceiling on total processing time.
		PipelineTimeout: 0,
		// MaxVideoBytes: 0 means "use defaultMaxVideoBytes (2 GB)".
		// Set a positive value to override.
		MaxVideoBytes:                    0,
		TempDir:                          "",
		ChunkingTimeout:                  3 * time.Minute,
		InteractionGenTimeout:            2 * time.Minute,
		TTSRequestTimeout:                2 * time.Minute,
		AudioGradeSTTTimeout:             90 * time.Second,
		WatchCoverageMaxRate:             4.0,
		WatchCoverageInitialGraceSeconds: 30,
		GradingTimeout:                   25 * time.Second,
		BackgroundTaskTimeout:            5 * time.Second,
		ListLimitChunks:                  500,
		ListLimitInteractions:            5000,
		ListLimitLessonOps:               10000,
		GeminiMaxAttempts:                4,
		GeminiRetryBackoff:               8 * time.Second,
	}
}

func NewAiCfgSvc(i do.Injector) (*AiCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.AiCfg, nil
}
