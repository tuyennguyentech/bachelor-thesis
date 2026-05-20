package ai

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	svcinteractions "example.com/richter/internal/svc/interactions"
)

// VieNeuTTSClient calls the VieNeu-TTS-v2 REST API to synthesise speech.
type VieNeuTTSClient struct {
	endpoint string // e.g. "http://vieneu-tts:8200"
	hc       *http.Client
}

func newVieNeuTTSClient(endpoint string) *VieNeuTTSClient {
	return &VieNeuTTSClient{endpoint: endpoint, hc: &http.Client{}}
}

// Synthesise converts text to MP3 audio using VieNeu-TTS-v2.
// language must be "vi" or "en".
// Returns raw MP3 bytes.
func (c *VieNeuTTSClient) Synthesise(ctx context.Context, text, language string) ([]byte, error) {
	// POST /tts?text=...&language=...
	// VieNeu-TTS-v2 accepts query params for simple requests.
	u, err := url.Parse(c.endpoint + "/tts")
	if err != nil {
		return nil, fmt.Errorf("vieneu-tts: parse endpoint: %w", err)
	}
	q := u.Query()
	q.Set("text", text)
	q.Set("language", language)
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(nil))
	if err != nil {
		return nil, fmt.Errorf("vieneu-tts: build request: %w", err)
	}
	req.Header.Set("Accept", "audio/mpeg")

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("vieneu-tts: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("vieneu-tts: status %d: %s", resp.StatusCode, string(body))
	}

	mp3, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("vieneu-tts: read body: %w", err)
	}
	if len(mp3) == 0 {
		return nil, fmt.Errorf("vieneu-tts: empty response body")
	}
	return mp3, nil
}

// synthesiseAndEmbed synthesises audio from text via TTS, uploads to S3, and
// returns updated configJSON with the new audio_object_key embedded.
func (s *AISvc) synthesiseAndEmbed(
	ctx context.Context,
	prov svcinteractions.TTSProvider,
	configJSON []byte,
	text, language string,
) ([]byte, error) {
	ttsCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	mp3, err := s.ttsClient.Synthesise(ttsCtx, text, language)
	if err != nil {
		return nil, fmt.Errorf("TTS synthesise: %w", err)
	}

	key := "ai-generated/audio/" + uuid.New().String() + ".mp3"
	_, err = s.s3client.PutObject(ctx, s.s3cfg.Bucket, key, bytes.NewReader(mp3), int64(len(mp3)), minio.PutObjectOptions{
		ContentType: "audio/mpeg",
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
