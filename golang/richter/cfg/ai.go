package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

// AiCfg groups runtime knobs for the AI service: model HTTP client
// timeouts (Whisper, Piper TTS, Gemini) and per-stage context deadlines
// (download, transcribe, chunk, generate interactions, grade). All
// duration fields accept 0 to mean "unlimited" (no deadline) wherever
// that is meaningful for the underlying context. Values < 0 are clamped
// to 0 by the service layer.
type AiCfg struct {
	// WhisperClientTimeout is the overall HTTP timeout for a single
	// Whisper request (whole transcription can take minutes for long
	// videos). 0 = unlimited (caller waits indefinitely).
	WhisperClientTimeout time.Duration `mapstructure:"whisper_client_timeout"`
	// WhisperIdleConnTimeout recycles idle connections to the Whisper
	// service. 0 = unlimited (never recycle; risk: sockets leak).
	WhisperIdleConnTimeout time.Duration `mapstructure:"whisper_idle_conn_timeout"`
	// WhisperResponseHeaderTimeout bounds the time we wait for the
	// server to send headers. 0 = unlimited (Whisper could accept a
	// request and hang forever).
	WhisperResponseHeaderTimeout time.Duration `mapstructure:"whisper_response_header_timeout"`
	// WhisperMaxIdleConnsPerHost caps the HTTP keep-alive pool size to
	// the Whisper service. 0 = Go default (unbounded per host).
	WhisperMaxIdleConnsPerHost int `mapstructure:"whisper_max_idle_conns_per_host"`
	// DownloadTimeout caps how long a worker may spend pulling a
	// source video from S3 / presigned URL. 0 = unlimited.
	DownloadTimeout time.Duration `mapstructure:"download_timeout"`
	// AudioExtractTimeout caps audio extraction (ffmpeg) for a single
	// source video. 0 = unlimited.
	AudioExtractTimeout time.Duration `mapstructure:"audio_extract_timeout"`
	// WhisperRequestTimeout caps a single Whisper request, including
	// upload of the audio. With segmentation enabled (the default) this
	// bounds the transcription of ONE audio chunk, not the whole video,
	// so it can stay modest even for multi-hour videos. 0 = unlimited.
	WhisperRequestTimeout time.Duration `mapstructure:"whisper_request_timeout"`
	// WhisperSegmentSeconds splits the extracted audio into chunks of
	// this many seconds, each transcribed as a separate bounded Whisper
	// request, then stitched back with offset timestamps. This is what
	// lets the pipeline handle arbitrarily long videos (> 1h) with
	// bounded per-request time and memory — a single 1h+ request would
	// otherwise blow past the per-request timeout and stream a huge body
	// from a non-streaming server. 0 = disable (one request for the whole
	// video; only safe for short clips). Recommended: 600 (10 min).
	WhisperSegmentSeconds int `mapstructure:"whisper_segment_seconds"`
	// WhisperProgressInterval is the heartbeat cadence of the
	// "Whisper đang chạy, vui lòng đợi…" progress message. 0 = no
	// progress emit (worker appears stuck until completion).
	WhisperProgressInterval time.Duration `mapstructure:"whisper_progress_interval"`
	// WhisperMaxConcurrent caps the number of in-flight Whisper
	// requests across the whole process. When > 0, the transcription
	// service acquires a token before each call and releases it on
	// completion. Excess callers block. This protects the Whisper
	// server (speaches) from being overwhelmed by N workers hitting it
	// at once — the most common cause of "timeout awaiting response
	// headers" failures under parallel transcribe. 0 = unlimited
	// (rely on worker count only). Recommended: 1 for the default
	// speaches deployment since it serializes model inference.
	WhisperMaxConcurrent int `mapstructure:"whisper_max_concurrent"`
	// PiperMaxConcurrent caps in-flight Piper TTS requests across the
	// whole process — the same app-side semaphore idea as
	// WhisperMaxConcurrent, applied to the other local AI service.
	// Piper's Flask server is already multi-threaded so 0 = unlimited is
	// usually fine; set > 0 to bound load on a constrained host. Pair it
	// with PIPER_NUM_WORKERS on the piper service. Override via env
	// RICHTER_AI_PIPER_MAX_CONCURRENT.
	PiperMaxConcurrent int `mapstructure:"piper_max_concurrent"`
	// PipelineTimeout is the total wall-clock budget for the full
	// extract pipeline (download + ffmpeg + Whisper). It wraps the
	// outer context of runWhisperAnalyze so a hung ffmpeg or Whisper
	// call cannot block a worker indefinitely past the sum of the
	// per-stage timeouts. 0 = unlimited (rely on per-stage timeouts
	// only). A generous value — e.g. DownloadTimeout +
	// AudioExtractTimeout + WhisperRequestTimeout + 5m buffer — is
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
	// TTSRequestTimeout caps a single Piper TTS call. 0 = unlimited.
	TTSRequestTimeout time.Duration `mapstructure:"tts_request_timeout"`
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
}

// DefaultMaxVideoBytes is the default cap for video file downloads (2 GB).
// Used by the transcription service when AiCfg.MaxVideoBytes is 0.
// Ops should override via [ai] max_video_bytes in richter.*.toml or
// RICHTER_AI_MAX_VIDEO_BYTES for deployment-specific limits.
const DefaultMaxVideoBytes = int64(2 * 1024 * 1024 * 1024) // 2 GB

func NewAiCfg() AiCfg {
	return AiCfg{
		// Per-chunk budgets (segmentation is on by default): each value
		// bounds the transcription of one WhisperSegmentSeconds chunk, so
		// a multi-hour video is a sequence of bounded requests.
		WhisperClientTimeout:   30 * time.Minute,
		WhisperIdleConnTimeout: 90 * time.Second,
		// 0 = disabled. speaches' /v1/audio/transcriptions is NON-streaming:
		// it sends response headers only AFTER the whole chunk is
		// transcribed, so a header timeout is indistinguishable from "still
		// working" and would wrongly kill slow-but-healthy chunks. The
		// per-request WhisperRequestTimeout is the real bound instead.
		WhisperResponseHeaderTimeout: 0,
		WhisperMaxIdleConnsPerHost:   10,
		DownloadTimeout:              10 * time.Minute,
		// ffmpeg now decodes the whole video in one pass while segmenting;
		// a 1h+ source needs more than the old 3m. Decode is several×
		// realtime so 15m covers multi-hour videos comfortably.
		AudioExtractTimeout:     15 * time.Minute,
		WhisperRequestTimeout:   30 * time.Minute,
		WhisperSegmentSeconds:   600,
		WhisperProgressInterval: 20 * time.Second,
		WhisperMaxConcurrent:    1,
		// 0 = unlimited (Piper is multi-threaded and cheap); override via
		// RICHTER_AI_PIPER_MAX_CONCURRENT if a host needs a hard cap.
		PiperMaxConcurrent: 0,
		// 0 = unlimited. A fixed wall-clock budget would cap how long a
		// video can be (a 33-min budget kills a 1h+ transcription mid-way).
		// Each stage is independently bounded (DownloadTimeout,
		// AudioExtractTimeout, and per-chunk WhisperRequestTimeout), so no
		// single stage can hang; the pipeline simply takes as long as the
		// video legitimately needs. Set a positive value only to impose a
		// hard ceiling on total processing time.
		PipelineTimeout: 0,
		// MaxVideoBytes: 0 means "use defaultMaxVideoBytes (2 GB)".
		// Set a positive value to override.
		MaxVideoBytes:         0,
		TempDir:               "",
		ChunkingTimeout:       3 * time.Minute,
		InteractionGenTimeout: 2 * time.Minute,
		TTSRequestTimeout:     2 * time.Minute,
		GradingTimeout:        25 * time.Second,
		BackgroundTaskTimeout: 5 * time.Second,
		ListLimitChunks:       500,
		ListLimitInteractions: 5000,
		ListLimitLessonOps:    10000,
	}
}

func NewAiCfgSvc(i do.Injector) (*AiCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.AiCfg, nil
}
