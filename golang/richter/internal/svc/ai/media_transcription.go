package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"github.com/minio/minio-go/v7"
)

type transcriptionService struct {
	s3client   *minio.Client
	s3cfg      *cfg.S3Cfg
	whisperCfg *cfg.WhisperCfg
}

func newTranscriptionService(s3client *minio.Client, s3cfg *cfg.S3Cfg, whisperCfg *cfg.WhisperCfg) *transcriptionService {
	return &transcriptionService{s3client: s3client, s3cfg: s3cfg, whisperCfg: whisperCfg}
}

func (s *transcriptionService) downloadVideo(ctx context.Context, storageKey string) (string, string, error) {
	s3ctx, s3cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer s3cancel()

	const maxVideoBytes = int64(500 * 1024 * 1024) // 500 MB

	ext := "mp4"
	mimeType := "video/mp4"
	if idx := strings.LastIndex(storageKey, "."); idx >= 0 {
		switch strings.ToLower(storageKey[idx+1:]) {
		case "mp4":
			ext, mimeType = "mp4", "video/mp4"
		case "webm":
			ext, mimeType = "webm", "video/webm"
		case "mov":
			ext, mimeType = "mov", "video/quicktime"
		case "avi":
			ext, mimeType = "avi", "video/x-msvideo"
		}
	}

	videoTmp, err := os.CreateTemp("", "richter-video-*."+ext)
	if err != nil {
		return "", "", fmt.Errorf("create temp video file: %w", err)
	}
	videoPath := videoTmp.Name()
	cleanup := func() {
		_ = os.Remove(videoPath)
	}

	obj, err := s.s3client.GetObject(s3ctx, s.s3cfg.Bucket, storageKey, minio.GetObjectOptions{})
	if err != nil {
		cleanup()
		return "", "", fmt.Errorf("download video from storage: %w", err)
	}

	// Stream the object body directly to a temp file. The previous implementation
	// loaded up to 500 MB into RAM before handing it to ffmpeg, which could OOM
	// the server under concurrent analyses. LimitReader caps writes so a
	// malicious or truncated file can never balloon the temp file beyond the cap.
	written, err := io.Copy(videoTmp, io.LimitReader(obj, maxVideoBytes+1))
	_ = videoTmp.Close()
	_ = obj.Close()
	if err != nil {
		cleanup()
		return "", "", fmt.Errorf("stream video to temp: %w", err)
	}
	if written > maxVideoBytes {
		cleanup()
		return "", "", fmt.Errorf("video file exceeds maximum size of 500 MB")
	}
	return videoPath, mimeType, nil
}

// extractAudio runs ffmpeg to extract 16kHz mono WAV audio from a video file path.
// The caller owns the input video file; we only own the output WAV. WAV is written
// to a temp file because ffmpeg requires seekable output for correct size headers.
func extractAudio(ctx context.Context, videoPath string) ([]byte, error) {
	audioTmp, err := os.CreateTemp("", "richter-audio-*.wav")
	if err != nil {
		return nil, fmt.Errorf("create temp wav file: %w", err)
	}
	audioPath := audioTmp.Name()
	audioTmp.Close()
	defer os.Remove(audioPath)

	cmd := exec.CommandContext(ctx,
		"ffmpeg", "-hide_banner", "-loglevel", "error",
		"-y",
		"-i", videoPath,
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		audioPath,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg extract audio: %w: %s", err, stderr.String())
	}
	return os.ReadFile(audioPath)
}

// whisperTranscribe sends audio bytes to the faster-whisper-server and returns
// the full transcript text along with fine-grained segment timestamps.
func (s *transcriptionService) whisperTranscribe(ctx context.Context, audioBytes []byte) (string, []transcriptSegment, error) {
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)

	// Set Content-Type to audio/wav so speaches can detect the format correctly.
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="file"; filename="audio.wav"`)
	h.Set("Content-Type", "audio/wav")
	fw, err := w.CreatePart(h)
	if err != nil {
		return "", nil, fmt.Errorf("create file part: %w", err)
	}
	if _, err := fw.Write(audioBytes); err != nil {
		return "", nil, fmt.Errorf("write audio bytes: %w", err)
	}
	if err := w.WriteField("model", s.whisperCfg.Model); err != nil {
		return "", nil, fmt.Errorf("write model field: %w", err)
	}
	if err := w.WriteField("response_format", "verbose_json"); err != nil {
		return "", nil, fmt.Errorf("write response_format: %w", err)
	}
	if err := w.WriteField("timestamp_granularities[]", "segment"); err != nil {
		return "", nil, fmt.Errorf("write timestamp_granularities: %w", err)
	}
	w.Close()

	url := "http://" + s.whisperCfg.Endpoint + "/v1/audio/transcriptions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return "", nil, fmt.Errorf("build whisper request: %w", err)
	}
	httpReq.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return "", nil, fmt.Errorf("call whisper API: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", nil, fmt.Errorf("read whisper response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("whisper API %d: %s", resp.StatusCode, string(respBytes))
	}

	var result struct {
		Text     string `json:"text"`
		Segments []struct {
			Start float32 `json:"start"`
			End   float32 `json:"end"`
			Text  string  `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(respBytes, &result); err != nil {
		return "", nil, fmt.Errorf("parse whisper response: %w", err)
	}

	segs := make([]transcriptSegment, len(result.Segments))
	for i, seg := range result.Segments {
		segs[i] = transcriptSegment{
			StartSeconds: seg.Start,
			EndSeconds:   seg.End,
			Text:         strings.TrimSpace(seg.Text),
		}
	}
	return strings.TrimSpace(result.Text), segs, nil
}

// runWhisperAnalyze is the Whisper-based replacement for runGeminiAnalyze.
// Pipeline: download video -> ffmpeg extract audio -> Whisper transcription.
func (s *transcriptionService) runWhisperAnalyze(ctx context.Context, storageKey string, progress progressFn) (transcript string, segments []transcriptSegment, err error) {
	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DOWNLOADING,
		"Đang tải video từ storage..."); err != nil {
		return "", nil, err
	}
	videoPath, _, dlErr := s.downloadVideo(ctx, storageKey)
	if dlErr != nil {
		return "", nil, dlErr
	}
	defer os.Remove(videoPath)

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UPLOADING,
		"Đang trích xuất âm thanh..."); err != nil {
		return "", nil, err
	}
	audioCtx, audioCancel := context.WithTimeout(ctx, 3*time.Minute)
	defer audioCancel()
	audioBytes, audioErr := extractAudio(audioCtx, videoPath)
	if audioErr != nil {
		return "", nil, fmt.Errorf("extract audio: %w", audioErr)
	}

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING,
		"Đang phiên âm bằng Whisper..."); err != nil {
		return "", nil, err
	}
	whisperCtx, whisperCancel := context.WithTimeout(ctx, 10*time.Minute)
	defer whisperCancel()

	type whisperResult struct {
		transcript string
		segments   []transcriptSegment
		err        error
	}
	resultCh := make(chan whisperResult, 1)
	go func() {
		transcript, segments, err := s.whisperTranscribe(whisperCtx, audioBytes)
		resultCh <- whisperResult{transcript: transcript, segments: segments, err: err}
	}()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	var result whisperResult
	for {
		select {
		case result = <-resultCh:
			goto whisperDone
		case <-ticker.C:
			if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING,
				"Đang phiên âm bằng Whisper..."); err != nil {
				whisperCancel()
				return "", nil, err
			}
		case <-ctx.Done():
			whisperCancel()
			return "", nil, ctx.Err()
		}
	}

whisperDone:
	transcript, segments, whisperErr := result.transcript, result.segments, result.err
	if whisperErr != nil {
		return "", nil, fmt.Errorf("whisper transcription: %w", whisperErr)
	}
	if strings.TrimSpace(transcript) == "" {
		return "", nil, fmt.Errorf("Whisper trả về transcript rỗng — video có thể không có lời nói hoặc chất lượng âm thanh quá thấp")
	}

	return transcript, segments, nil
}
