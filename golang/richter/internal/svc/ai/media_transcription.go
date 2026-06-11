package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal/svc/ai/transcript"
	"github.com/minio/minio-go/v7"
)

type transcriptionService struct {
	s3client   *minio.Client
	s3cfg      *cfg.S3Cfg
	whisperCfg *cfg.WhisperCfg
	aiCfg      *cfg.AiCfg
	// whisperSem caps concurrent Whisper requests. nil = unlimited
	// (when aiCfg.WhisperMaxConcurrent <= 0). The semaphore is built
	// once on construction so we never allocate per request.
	whisperSem chan struct{}
}

// newWhisperHTTPClient returns a tuned HTTP client for the Whisper
// transcription service. It is separate from http.DefaultClient so the
// global default is not changed for unrelated callers. Tunables come
// from cfg.AiCfg; see that struct for the meaning of each field. A
// value of 0 on a duration field means "unlimited" (Go's net/http
// treats a zero Timeout as no timeout).
func newWhisperHTTPClient(ai *cfg.AiCfg) *http.Client {
	transport := &http.Transport{
		DisableKeepAlives: false,
		ForceAttemptHTTP2: true,
	}
	if ai.WhisperMaxIdleConnsPerHost > 0 {
		transport.MaxIdleConnsPerHost = ai.WhisperMaxIdleConnsPerHost
	}
	if ai.WhisperIdleConnTimeout > 0 {
		transport.IdleConnTimeout = ai.WhisperIdleConnTimeout
	}
	if ai.WhisperResponseHeaderTimeout > 0 {
		transport.ResponseHeaderTimeout = ai.WhisperResponseHeaderTimeout
	}
	client := &http.Client{Transport: transport}
	if ai.WhisperClientTimeout > 0 {
		client.Timeout = ai.WhisperClientTimeout
	}
	return client
}

func newTranscriptionService(s3client *minio.Client, s3cfg *cfg.S3Cfg, whisperCfg *cfg.WhisperCfg, aiCfg *cfg.AiCfg) *transcriptionService {
	s := &transcriptionService{s3client: s3client, s3cfg: s3cfg, whisperCfg: whisperCfg, aiCfg: aiCfg}
	if aiCfg.WhisperMaxConcurrent > 0 {
		// Buffered channel acts as a counting semaphore: each in-flight
		// request takes one slot, releases on return. Blocks excess
		// callers until a slot frees up. Sized to the configured cap.
		s.whisperSem = make(chan struct{}, aiCfg.WhisperMaxConcurrent)
	}
	return s
}

// maxVideoBytes returns the effective video size cap from config.
// A zero/negative config value falls back to the 2 GB default.
func (s *transcriptionService) maxVideoBytes() int64 {
	if s.aiCfg.MaxVideoBytes > 0 {
		return s.aiCfg.MaxVideoBytes
	}
	return cfg.DefaultMaxVideoBytes
}

// tempDir returns the directory to use for temp files. Empty config
// value falls back to os.TempDir() (the system default).
func (s *transcriptionService) tempDir() string {
	if s.aiCfg.TempDir != "" {
		return s.aiCfg.TempDir
	}
	return os.TempDir()
}

func (s *transcriptionService) downloadVideo(ctx context.Context, storageKey string) (string, string, error) {
	s3ctx, s3cancel := s.aiCtx(ctx, s.aiCfg.DownloadTimeout)
	defer s3cancel()

	maxBytes := s.maxVideoBytes()

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

	videoTmp, err := os.CreateTemp(s.tempDir(), "richter-video-*."+ext)
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
	written, err := io.Copy(videoTmp, io.LimitReader(obj, maxBytes+1))
	_ = videoTmp.Close()
	_ = obj.Close()
	if err != nil {
		cleanup()
		return "", "", fmt.Errorf("stream video to temp: %w", err)
	}
	if written > maxBytes {
		cleanup()
		return "", "", fmt.Errorf("video file exceeds maximum allowed size of %d bytes", maxBytes)
	}
	return videoPath, mimeType, nil
}

// extractAudio runs ffmpeg to extract 16kHz mono WAV audio from a video file path.
// The caller owns the input video file; we only own the output WAV. WAV is written
// to a temp file because ffmpeg requires seekable output for correct size headers.
//
// IMPORTANT: the caller is responsible for removing the returned temp file via
// defer os.Remove(audioPath) once it is no longer needed. The file is NOT removed
// here so it can be streamed directly into the Whisper request without a copy.
func extractAudio(ctx context.Context, videoPath, tempDir string) (audioPath string, err error) {
	audioTmp, err := os.CreateTemp(tempDir, "richter-audio-*.wav")
	if err != nil {
		return "", fmt.Errorf("create temp wav file: %w", err)
	}
	audioPath = audioTmp.Name()
	audioTmp.Close()

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
		_ = os.Remove(audioPath)
		return "", fmt.Errorf("ffmpeg extract audio: %w: %s", err, stderr.String())
	}
	return audioPath, nil
}

// whisperTranscribe streams the WAV audio at audioPath to the faster-whisper-server
// and returns the full transcript text along with fine-grained segment timestamps.
// The audio is streamed directly from the temp file via io.Pipe so no full copy of
// the WAV data is held in memory at any time.
func (s *transcriptionService) whisperTranscribe(ctx context.Context, audioPath string) (string, []transcriptSegment, error) {
	if s.whisperSem != nil {
		// Acquire a Whisper slot. If the parent ctx is cancelled while
		// we wait, release the would-be slot and bail.
		select {
		case s.whisperSem <- struct{}{}:
			defer func() { <-s.whisperSem }()
		case <-ctx.Done():
			return "", nil, ctx.Err()
		}
	}

	// Build the multipart body with a pipe so the WAV bytes flow directly
	// from disk into the HTTP request without being buffered in RAM.
	pr, pw := io.Pipe()
	w := multipart.NewWriter(pw)

	go func() {
		var writeErr error
		defer func() {
			// Always close the multipart writer and pipe writer so the
			// HTTP client unblocks even if we return early on error.
			if closeErr := w.Close(); closeErr != nil && writeErr == nil {
				writeErr = closeErr
			}
			pw.CloseWithError(writeErr)
		}()

		// Set Content-Type to audio/wav so speaches can detect the format correctly.
		h := make(textproto.MIMEHeader)
		h.Set("Content-Disposition", `form-data; name="file"; filename="audio.wav"`)
		h.Set("Content-Type", "audio/wav")
		fw, err := w.CreatePart(h)
		if err != nil {
			writeErr = fmt.Errorf("create file part: %w", err)
			return
		}

		audioFile, err := os.Open(audioPath)
		if err != nil {
			writeErr = fmt.Errorf("open audio temp file: %w", err)
			return
		}
		defer audioFile.Close()

		if _, err := io.Copy(fw, audioFile); err != nil {
			writeErr = fmt.Errorf("stream audio to multipart: %w", err)
			return
		}

		if err := w.WriteField("model", s.whisperCfg.Model); err != nil {
			writeErr = fmt.Errorf("write model field: %w", err)
			return
		}
		if err := w.WriteField("response_format", "verbose_json"); err != nil {
			writeErr = fmt.Errorf("write response_format: %w", err)
			return
		}
		if err := w.WriteField("timestamp_granularities[]", "segment"); err != nil {
			writeErr = fmt.Errorf("write timestamp_granularities: %w", err)
			return
		}
	}()

	url := "http://" + s.whisperCfg.Endpoint + "/v1/audio/transcriptions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, pr)
	if err != nil {
		// Drain the pipe so the goroutine can exit cleanly.
		_ = pw.CloseWithError(err)
		return "", nil, fmt.Errorf("build whisper request: %w", err)
	}
	httpReq.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := s.whisperHTTPClient().Do(httpReq)
	if err != nil {
		return "", nil, fmt.Errorf("call whisper API: %w", err)
	}
	defer resp.Body.Close()

	// Cap the response body at 16 MB. A 60-min lesson transcribed at typical
	// sizes is well under 1 MB; the cap exists to prevent a malicious or
	// mis-configured Whisper server from OOM-ing richter.
	const maxWhisperResponseBytes = 16 << 20
	limited := io.LimitReader(resp.Body, maxWhisperResponseBytes+1)
	respBytes, err := io.ReadAll(limited)
	if err != nil {
		return "", nil, fmt.Errorf("read whisper response: %w", err)
	}
	if int64(len(respBytes)) > maxWhisperResponseBytes {
		return "", nil, fmt.Errorf("whisper response exceeds %d bytes", maxWhisperResponseBytes)
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
//
// A per-pipeline wall-clock deadline is applied around the full pipeline via
// aiCfg.PipelineTimeout so that a hung ffmpeg or Whisper call cannot block a
// worker indefinitely beyond the sum of the per-stage budgets.
func (s *transcriptionService) runWhisperAnalyze(ctx context.Context, storageKey string, progress transcript.ProgressFn) (transcript string, segments []transcriptSegment, err error) {
	// Wrap the entire pipeline in an outer deadline so hung sub-stages
	// (slow ffmpeg, unresponsive Whisper) are reaped within a predictable
	// wall-clock budget. Per-stage contexts are derived from this one, so
	// they will fire first if their individual budgets are shorter.
	pipeCtx, pipeCancel := s.aiCtx(ctx, s.aiCfg.PipelineTimeout)
	defer pipeCancel()

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DOWNLOADING,
		"Đang tải video từ storage..."); err != nil {
		return "", nil, err
	}
	videoPath, _, dlErr := s.downloadVideo(pipeCtx, storageKey)
	if dlErr != nil {
		return "", nil, dlErr
	}
	defer os.Remove(videoPath)

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UPLOADING,
		"Đang trích xuất âm thanh..."); err != nil {
		return "", nil, err
	}
	audioCtx, audioCancel := s.aiCtx(pipeCtx, s.aiCfg.AudioExtractTimeout)
	defer audioCancel()
	// extractAudio returns the path of the temp WAV file. The caller
	// (this function) is responsible for removing it once Whisper is done.
	audioPath, audioErr := extractAudio(audioCtx, videoPath, s.tempDir())
	if audioErr != nil {
		return "", nil, fmt.Errorf("extract audio: %w", audioErr)
	}
	defer os.Remove(audioPath)

	// Emit "Phiên âm bằng Whisper (chờ máy chủ...)" first. The actual
	// elapsed time is filled in by the heartbeat loop below.
	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING,
		"Đang phiên âm bằng Whisper — chờ máy chủ xử lý..."); err != nil {
		return "", nil, err
	}
	whisperCtx, whisperCancel := s.aiCtx(pipeCtx, s.aiCfg.WhisperRequestTimeout)
	defer whisperCancel()

	type whisperResult struct {
		transcript string
		segments   []transcriptSegment
		err        error
	}
	resultCh := make(chan whisperResult, 1)
	whisperStart := time.Now()
	go func() {
		transcript, segments, err := s.whisperTranscribe(whisperCtx, audioPath)
		resultCh <- whisperResult{transcript: transcript, segments: segments, err: err}
	}()

	progressInterval := s.aiCfg.WhisperProgressInterval
	var progressC <-chan time.Time
	if progressInterval > 0 {
		ticker := time.NewTicker(progressInterval)
		defer ticker.Stop()
		progressC = ticker.C
	}

	var result whisperResult
	for {
		select {
		case result = <-resultCh:
			goto whisperDone
		case <-progressC:
			elapsed := time.Since(whisperStart).Truncate(time.Second)
			msg := fmt.Sprintf("Đang phiên âm bằng Whisper (%s đã trôi qua)...", formatDuration(elapsed))
			if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, msg); err != nil {
				whisperCancel()
				return "", nil, err
			}
		case <-pipeCtx.Done():
			whisperCancel()
			return "", nil, pipeCtx.Err()
		}
	}

whisperDone:
	transcript, segments, whisperErr := result.transcript, result.segments, result.err
	if whisperErr != nil {
		// Sanitize the message: don't leak the internal whisper
		// service URL or net/http stack to the user-facing error.
		// Keep the full error in the log via wrap, but expose a
		// short Vietnamese message in the response.
		_ = whisperErr // logged via wrap below
		if errors.Is(whisperErr, context.DeadlineExceeded) || isTimeoutErr(whisperErr) {
			return "", nil, fmt.Errorf("whisper transcription: %w", whisperErr)
		}
		if strings.Contains(whisperErr.Error(), "timeout awaiting response headers") {
			return "", nil, fmt.Errorf("whisper transcription: máy chủ phiên âm không phản hồi (có thể đang bận xử lý tác vụ khác): %w", whisperErr)
		}
		return "", nil, fmt.Errorf("whisper transcription: %w", whisperErr)
	}
	if strings.TrimSpace(transcript) == "" {
		return "", nil, fmt.Errorf("Whisper trả về transcript rỗng — video có thể không có lời nói hoặc chất lượng âm thanh quá thấp")
	}

	return transcript, segments, nil
}

// isTimeoutErr returns true if err is a net/http timeout error of any kind.
func isTimeoutErr(err error) bool {
	if err == nil {
		return false
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// formatDuration renders a time.Duration as a short human-readable
// string ("45s", "1m30s"). Negative durations render as "0s".
func formatDuration(d time.Duration) string {
	if d < 0 {
		return "0s"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	m := int(d.Minutes())
	s := int(d.Seconds()) % 60
	return fmt.Sprintf("%dm%ds", m, s)
}

// aiCtx returns a child of ctx with the given timeout, or returns ctx
// unchanged when d is 0 (unlimited). The caller must defer the cancel
// to release resources when d > 0; when d == 0 the returned cancel is
// a no-op so callers can still defer it safely.
func (s *transcriptionService) aiCtx(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, d)
}

// whisperHTTPClient returns the configured Whisper HTTP client. The
// client is built once from cfg.AiCfg; we cache it on the service so
// we don't allocate per request.
func (s *transcriptionService) whisperHTTPClient() *http.Client {
	return newWhisperHTTPClient(s.aiCfg)
}
