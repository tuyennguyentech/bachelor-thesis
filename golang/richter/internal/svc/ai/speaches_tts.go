package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"example.com/richter/cfg"
	svcinteractions "example.com/richter/internal/svc/interactions"
)

// TTSSynthesizer synthesises speech audio (WAV bytes) from text in a given
// language ("vi" or "en"). AISvc depends on this abstraction rather than a
// concrete client, so the TTS backend can be swapped without touching callers.
type TTSSynthesizer interface {
	Synthesise(ctx context.Context, text, language string) ([]byte, error)
}

// SpeachesTTSClient is the Speaches-backed TTSSynthesizer: it calls the Speaches
// OpenAI-compatible /v1/audio/speech endpoint. Speaches serves Piper voices;
// each language maps to a (model, voice) pair from TTSCfg.
type SpeachesTTSClient struct {
	cfg *cfg.TTSCfg
	hc  *http.Client
	// sem is a counting semaphore capping concurrent in-flight TTS
	// requests when maxConcurrent > 0; nil = unlimited.
	sem chan struct{}
}

var _ TTSSynthesizer = (*SpeachesTTSClient)(nil)

// newSpeachesTTSClient builds the client. backstopTimeout is a coarse safety net
// on the HTTP client so a caller that forgets to bound the context cannot hang
// forever; the real per-call bound is the context deadline (callers wrap with
// AiCfg.TTSRequestTimeout). 0 = no client-level timeout.
func newSpeachesTTSClient(ttsCfg *cfg.TTSCfg, maxConcurrent int, backstopTimeout time.Duration) *SpeachesTTSClient {
	c := &SpeachesTTSClient{cfg: ttsCfg, hc: &http.Client{Timeout: backstopTimeout}}
	if maxConcurrent > 0 {
		c.sem = make(chan struct{}, maxConcurrent)
	}
	return c
}

// endpointWithScheme returns endpoint with an http:// scheme prepended if it has
// none, so a Speaches endpoint configured either way ("speaches:8000" or
// "http://speaches:8000") works. Shared by the STT and TTS clients so the two
// sibling settings cannot become a latent trap (prepending to an already-schemed
// value would yield "http://http://…").
func endpointWithScheme(endpoint string) string {
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		return "http://" + endpoint
	}
	return endpoint
}

// speechURL builds the /v1/audio/speech URL from the configured TTS endpoint.
func (c *SpeachesTTSClient) speechURL() string {
	return endpointWithScheme(c.cfg.Endpoint) + "/v1/audio/speech"
}

// modelVoice maps a language to the configured Speaches model + voice.
// Defaults to Vietnamese (the platform is Vietnamese-primary).
func (c *SpeachesTTSClient) modelVoice(language string) (model, voice string) {
	if language == "en" {
		return c.cfg.EnModel, c.cfg.EnVoice
	}
	return c.cfg.ViModel, c.cfg.ViVoice
}

type speachesSpeechRequest struct {
	Model          string `json:"model"`
	Input          string `json:"input"`
	Voice          string `json:"voice"`
	ResponseFormat string `json:"response_format"`
}

// Synthesise converts text to WAV audio via Speaches. language "vi" or "en".
// Returns raw WAV bytes.
func (c *SpeachesTTSClient) Synthesise(ctx context.Context, text, language string) ([]byte, error) {
	// App-side concurrency gate (mirrors the STT semaphore): bound
	// concurrent TTS calls when TTSMaxConcurrent > 0.
	if c.sem != nil {
		select {
		case c.sem <- struct{}{}:
			defer func() { <-c.sem }()
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	model, voice := c.modelVoice(language)
	body, err := json.Marshal(speachesSpeechRequest{
		Model:          model,
		Input:          text,
		Voice:          voice,
		ResponseFormat: "wav",
	})
	if err != nil {
		return nil, fmt.Errorf("speaches-tts: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.speechURL(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("speaches-tts: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "audio/wav")

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("speaches-tts: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("speaches-tts: status %d: %s", resp.StatusCode, string(b))
	}

	// Cap the TTS response at 25 MB. A few sentences of 24 kHz mono WAV is well
	// under 1 MB; 25 MB still bounds a misbehaving/ misconfigured server but is
	// generous enough (~8 min of audio) not to truncate a long listening passage.
	const maxTTSResponseBytes = 25 << 20
	wav, err := io.ReadAll(io.LimitReader(resp.Body, maxTTSResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("speaches-tts: read body: %w", err)
	}
	if int64(len(wav)) > maxTTSResponseBytes {
		return nil, fmt.Errorf("speaches-tts: response exceeds %d bytes", maxTTSResponseBytes)
	}
	if len(wav) == 0 {
		return nil, fmt.Errorf("speaches-tts: empty response body")
	}
	return wav, nil
}

// synthesiseAndEmbed synthesises audio from text via Speaches TTS, uploads to S3
// under `lessons/<lessonID>/ai-audio/<uuid>.wav`, and returns updated configJSON
// with the new audio_object_key embedded.
//
// The lesson-scoped key prefix is required so that StorageSvc.orgIDForKey can
// resolve the owning org for authorization; non-scoped prefixes like
// `ai-generated/…` were rejected by the storage authz layer.
func (s *AISvc) synthesiseAndEmbed(
	ctx context.Context,
	prov svcinteractions.TTSProvider,
	configJSON []byte,
	text, language, lessonID string,
) ([]byte, error) {
	if lessonID == "" {
		return nil, fmt.Errorf("TTS: lessonID required for lesson-scoped audio key")
	}

	wav, err := s.synthesiseWithRetry(ctx, text, language)
	if err != nil {
		return nil, err
	}

	key := "lessons/" + lessonID + "/ai-audio/" + uuid.New().String() + ".wav"
	_, err = s.s3client.PutObject(ctx, s.s3cfg.Bucket, key, bytes.NewReader(wav), int64(len(wav)), minio.PutObjectOptions{
		ContentType: "audio/wav",
	})
	if err != nil {
		return nil, fmt.Errorf("TTS upload: %w", err)
	}

	updated, err := prov.SetAudioObjectKey(configJSON, key)
	if err != nil {
		return nil, fmt.Errorf("TTS set key: %w", err)
	}
	return updated, nil
}

// synthesiseWithRetry calls the TTS backend with bounded retry-with-backoff.
// Transient Speaches/network failures (5xx/429, timeout, empty body) are the
// reason listening questions silently went missing in some chunks: a single
// failed call dropped the whole item. Retrying TTSMaxAttempts times recovers
// from transient hiccups so every chunk keeps its listening question.
func (s *AISvc) synthesiseWithRetry(ctx context.Context, text, language string) ([]byte, error) {
	attempts := s.aiCfg.TTSMaxAttempts
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 1; ; attempt++ {
		ttsCtx, cancel := s.aiCtx(ctx, s.aiCfg.TTSRequestTimeout)
		wav, err := s.ttsClient.Synthesise(ttsCtx, text, language)
		cancel()
		if err == nil {
			return wav, nil
		}
		if attempt >= attempts || ctx.Err() != nil {
			return nil, fmt.Errorf("TTS synthesise (sau %d lần thử): %w", attempt, err)
		}
		s.log.WarnContext(ctx, "ai: TTS synthesise failed, retrying",
			"attempt", attempt, "max", attempts, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * s.aiCfg.TTSRetryBackoff):
		}
	}
}
