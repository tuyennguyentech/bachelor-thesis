package ai

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	svcinteractions "example.com/richter/internal/svc/interactions"
)

// PiperTTSClient calls the Piper TTS HTTP API to synthesise speech.
type PiperTTSClient struct {
	endpoint string // e.g. "http://piper-tts:5000"
	hc       *http.Client
}

func newPiperTTSClient(endpoint string) *PiperTTSClient {
	return &PiperTTSClient{endpoint: endpoint, hc: &http.Client{}}
}

// Synthesise converts text to WAV audio using Piper TTS.
// language must be "vi" or "en".
// Returns raw WAV bytes.
func (c *PiperTTSClient) Synthesise(ctx context.Context, text, language string) ([]byte, error) {
	u, err := url.Parse(c.endpoint + "/tts")
	if err != nil {
		return nil, fmt.Errorf("piper-tts: parse endpoint: %w", err)
	}
	q := u.Query()
	q.Set("text", text)
	q.Set("language", language)
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(nil))
	if err != nil {
		return nil, fmt.Errorf("piper-tts: build request: %w", err)
	}
	req.Header.Set("Accept", "audio/wav")

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("piper-tts: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("piper-tts: status %d: %s", resp.StatusCode, string(body))
	}

	wav, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("piper-tts: read body: %w", err)
	}
	if len(wav) == 0 {
		return nil, fmt.Errorf("piper-tts: empty response body")
	}
	return wav, nil
}

// synthesiseAndEmbed synthesises audio from text via Piper TTS, uploads to S3
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
	ttsCtx, cancel := s.aiCtx(ctx, s.aiCfg.TTSRequestTimeout)
	defer cancel()

	wav, err := s.ttsClient.Synthesise(ttsCtx, text, language)
	if err != nil {
		return nil, fmt.Errorf("TTS synthesise: %w", err)
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
