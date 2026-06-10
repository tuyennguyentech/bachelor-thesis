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
	// upload of the audio. 0 = unlimited.
	WhisperRequestTimeout time.Duration `mapstructure:"whisper_request_timeout"`
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

func NewAiCfg() AiCfg {
	return AiCfg{
		WhisperClientTimeout:         10 * time.Minute,
		WhisperIdleConnTimeout:       90 * time.Second,
		WhisperResponseHeaderTimeout: 5 * time.Minute,
		WhisperMaxIdleConnsPerHost:   10,
		DownloadTimeout:              5 * time.Minute,
		AudioExtractTimeout:          3 * time.Minute,
		WhisperRequestTimeout:        10 * time.Minute,
		WhisperProgressInterval:      20 * time.Second,
		WhisperMaxConcurrent:         1,
		ChunkingTimeout:              3 * time.Minute,
		InteractionGenTimeout:        2 * time.Minute,
		TTSRequestTimeout:            2 * time.Minute,
		GradingTimeout:               25 * time.Second,
		BackgroundTaskTimeout:        5 * time.Second,
		ListLimitChunks:              500,
		ListLimitInteractions:        5000,
		ListLimitLessonOps:           10000,
	}
}

func NewAiCfgSvc(i do.Injector) (*AiCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.AiCfg, nil
}
