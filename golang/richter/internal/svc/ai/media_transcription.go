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
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal/svc/ai/transcript"
	"github.com/minio/minio-go/v7"
)

type transcriptionService struct {
	s3client *minio.Client
	s3cfg    *cfg.S3Cfg
	sttCfg   *cfg.STTCfg
	aiCfg    *cfg.AiCfg
	// sttSem caps concurrent STT requests. nil = unlimited
	// (when aiCfg.STTMaxConcurrent <= 0). The semaphore is built
	// once on construction so we never allocate per request.
	sttSem chan struct{}
	// sttClient is the tuned HTTP client for STT calls. Built
	// once on construction and reused so the underlying Transport's
	// connection pool (keep-alive, HTTP/2) survives across requests.
	sttClient *http.Client
}

// newSTTHTTPClient returns a tuned HTTP client for the STT
// transcription service. It is separate from http.DefaultClient so the
// global default is not changed for unrelated callers. Tunables come
// from cfg.AiCfg; see that struct for the meaning of each field. A
// value of 0 on a duration field means "unlimited" (Go's net/http
// treats a zero Timeout as no timeout).
func newSTTHTTPClient(ai *cfg.AiCfg) *http.Client {
	transport := &http.Transport{
		DisableKeepAlives: false,
		ForceAttemptHTTP2: true,
	}
	if ai.STTMaxIdleConnsPerHost > 0 {
		transport.MaxIdleConnsPerHost = ai.STTMaxIdleConnsPerHost
	}
	if ai.STTIdleConnTimeout > 0 {
		transport.IdleConnTimeout = ai.STTIdleConnTimeout
	}
	if ai.STTResponseHeaderTimeout > 0 {
		transport.ResponseHeaderTimeout = ai.STTResponseHeaderTimeout
	}
	client := &http.Client{Transport: transport}
	if ai.STTClientTimeout > 0 {
		client.Timeout = ai.STTClientTimeout
	}
	return client
}

func newTranscriptionService(s3client *minio.Client, s3cfg *cfg.S3Cfg, sttCfg *cfg.STTCfg, aiCfg *cfg.AiCfg) *transcriptionService {
	s := &transcriptionService{s3client: s3client, s3cfg: s3cfg, sttCfg: sttCfg, aiCfg: aiCfg}
	s.sttClient = newSTTHTTPClient(aiCfg)
	if aiCfg.STTMaxConcurrent > 0 {
		// Buffered channel acts as a counting semaphore: each in-flight
		// request takes one slot, releases on return. Blocks excess
		// callers until a slot frees up. Sized to the configured cap.
		s.sttSem = make(chan struct{}, aiCfg.STTMaxConcurrent)
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
// here so it can be streamed directly into the STT request without a copy.
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

// wavBytesPerSecond is the byte rate of the 16 kHz mono signed-16-bit PCM
// WAV we extract: 16000 samples/s × 2 bytes/sample. Used to derive a chunk's
// duration from its file size without spawning ffprobe.
const wavBytesPerSecond = 16000 * 2

// wavHeaderBytes is the size of the canonical 44-byte WAV header that
// precedes the PCM data ffmpeg writes.
const wavHeaderBytes = 44

// wavDurationSeconds returns the playback duration of a 16 kHz mono s16le WAV
// file computed from its size on disk. Returns 0 if the file is missing or
// smaller than the header. Exact for the PCM format we always produce, so it
// avoids an ffprobe call per chunk when stitching offsets.
func wavDurationSeconds(path string) float64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	dataBytes := fi.Size() - wavHeaderBytes
	if dataBytes <= 0 {
		return 0
	}
	return float64(dataBytes) / float64(wavBytesPerSecond)
}

// extractAudioSegments extracts the video's audio as a sequence of 16 kHz
// mono WAV chunks, each at most segmentSeconds long, written to outDir in a
// SINGLE ffmpeg pass straight from the video. No full-length WAV is ever
// produced — this is what keeps memory and per-request time bounded for very
// long (> 1h) videos. Returns the ordered chunk paths.
//
// When segmentSeconds <= 0 the audio is extracted as one file (the legacy
// whole-video behavior), still streamed to disk, never into memory.
//
// The caller owns outDir and every returned file; removing outDir (e.g. via
// os.RemoveAll) cleans them all up.
func extractAudioSegments(ctx context.Context, videoPath, outDir string, segmentSeconds int) ([]string, error) {
	if segmentSeconds <= 0 {
		audioPath, err := extractAudio(ctx, videoPath, outDir)
		if err != nil {
			return nil, err
		}
		return []string{audioPath}, nil
	}

	// ffmpeg's segment muxer cuts the PCM stream on packet boundaries; for
	// raw PCM every sample is independently addressable so the cuts land at
	// (approximately) segmentSeconds. We recompute each chunk's real offset
	// from its byte size when stitching, so any sub-second drift is exact.
	pattern := filepath.Join(outDir, "chunk_%05d.wav")
	cmd := exec.CommandContext(ctx,
		"ffmpeg", "-hide_banner", "-loglevel", "error",
		"-y",
		"-i", videoPath,
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		"-f", "segment",
		"-segment_time", strconv.Itoa(segmentSeconds),
		"-reset_timestamps", "1",
		pattern,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg segment audio: %w: %s", err, stderr.String())
	}

	matches, err := filepath.Glob(filepath.Join(outDir, "chunk_*.wav"))
	if err != nil {
		return nil, fmt.Errorf("list audio segments: %w", err)
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("ffmpeg produced no audio segments (video may have no audio track)")
	}
	// chunk_%05d.wav is zero-padded so lexical sort == chronological order.
	sort.Strings(matches)
	return matches, nil
}

// sttTranscribe streams the WAV audio at audioPath to the faster-whisper-server
// and returns the full transcript text along with fine-grained segment timestamps.
// The audio is streamed directly from the temp file via io.Pipe so no full copy of
// the WAV data is held in memory at any time.
func (s *transcriptionService) sttTranscribe(ctx context.Context, audioPath string) (string, []transcriptSegment, error) {
	if s.sttSem != nil {
		// Acquire a STT slot. If the parent ctx is cancelled while
		// we wait, release the would-be slot and bail.
		select {
		case s.sttSem <- struct{}{}:
			defer func() { <-s.sttSem }()
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

		if err := w.WriteField("model", s.sttCfg.Model); err != nil {
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

	url := endpointWithScheme(s.sttCfg.Endpoint) + "/v1/audio/transcriptions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, pr)
	if err != nil {
		// Drain the pipe so the goroutine can exit cleanly.
		_ = pw.CloseWithError(err)
		return "", nil, fmt.Errorf("build whisper request: %w", err)
	}
	httpReq.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := s.sttClient.Do(httpReq)
	if err != nil {
		return "", nil, fmt.Errorf("call whisper API: %w", err)
	}
	defer resp.Body.Close()

	// Cap the response body at 16 MB. A 60-min lesson transcribed at typical
	// sizes is well under 1 MB; the cap exists to prevent a malicious or
	// mis-configured STT server from OOM-ing richter.
	const maxSTTResponseBytes = 16 << 20
	limited := io.LimitReader(resp.Body, maxSTTResponseBytes+1)
	respBytes, err := io.ReadAll(limited)
	if err != nil {
		return "", nil, fmt.Errorf("read whisper response: %w", err)
	}
	if int64(len(respBytes)) > maxSTTResponseBytes {
		return "", nil, fmt.Errorf("whisper response exceeds %d bytes", maxSTTResponseBytes)
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

// runSTTAnalyze is the STT-based replacement for runGeminiAnalyze.
// Pipeline: download video -> ffmpeg extract audio -> STT transcription.
//
// A per-pipeline wall-clock deadline is applied around the full pipeline via
// aiCfg.PipelineTimeout so that a hung ffmpeg or STT call cannot block a
// worker indefinitely beyond the sum of the per-stage budgets.
func (s *transcriptionService) runSTTAnalyze(ctx context.Context, storageKey string, progress transcript.ProgressFn) (transcript string, segments []transcriptSegment, err error) {
	// Wrap the entire pipeline in an outer deadline so hung sub-stages
	// (slow ffmpeg, unresponsive STT) are reaped within a predictable
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
	// Extract the audio straight into time-bounded WAV chunks in a private
	// temp dir. A single ffmpeg pass; no full-length WAV is ever produced,
	// so this scales to arbitrarily long (> 1h) videos on bounded disk.
	segDir, segErr := os.MkdirTemp(s.tempDir(), "richter-segs-*")
	if segErr != nil {
		return "", nil, fmt.Errorf("create segment dir: %w", segErr)
	}
	defer os.RemoveAll(segDir)

	audioCtx, audioCancel := s.aiCtx(pipeCtx, s.aiCfg.AudioExtractTimeout)
	chunks, audioErr := extractAudioSegments(audioCtx, videoPath, segDir, s.aiCfg.STTSegmentSeconds)
	audioCancel()
	if audioErr != nil {
		return "", nil, fmt.Errorf("extract audio: %w", audioErr)
	}
	// The source video is no longer needed once audio is extracted; free
	// its disk immediately rather than waiting for the deferred remove,
	// which matters when several large videos transcribe back to back.
	_ = os.Remove(videoPath)

	if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING,
		"Đang phiên âm bằng STT — chờ máy chủ xử lý..."); err != nil {
		return "", nil, err
	}

	// Transcribe each chunk as a separate bounded request, stitching the
	// text and offsetting every segment's timestamps by the cumulative
	// duration of the chunks already processed. Each chunk's real duration
	// is read from its WAV byte size, so offsets are exact with no drift.
	var (
		textBuf strings.Builder
		allSegs []transcriptSegment
		offset  float64
	)
	for i, chunkPath := range chunks {
		label := ""
		if len(chunks) > 1 {
			label = fmt.Sprintf("phần %d/%d ", i+1, len(chunks))
		}
		text, segs, cErr := s.transcribeChunk(pipeCtx, chunkPath, label, progress)
		if cErr != nil {
			// Sanitize: don't leak the internal whisper URL / net/http
			// stack. Keep a short Vietnamese message; the wrap preserves
			// detail for the logs.
			if errors.Is(cErr, context.DeadlineExceeded) || isTimeoutErr(cErr) {
				return "", nil, fmt.Errorf("whisper transcription: %w", cErr)
			}
			if strings.Contains(cErr.Error(), "timeout awaiting response headers") {
				return "", nil, fmt.Errorf("whisper transcription: máy chủ phiên âm không phản hồi (có thể đang bận xử lý tác vụ khác): %w", cErr)
			}
			return "", nil, fmt.Errorf("whisper transcription: %w", cErr)
		}
		for j := range segs {
			segs[j].StartSeconds += float32(offset)
			segs[j].EndSeconds += float32(offset)
		}
		allSegs = append(allSegs, segs...)
		if t := strings.TrimSpace(text); t != "" {
			if textBuf.Len() > 0 {
				textBuf.WriteByte(' ')
			}
			textBuf.WriteString(t)
		}
		offset += wavDurationSeconds(chunkPath)
		// Free each chunk as soon as it is transcribed so a multi-hour
		// video never holds all its audio chunks on disk at once.
		_ = os.Remove(chunkPath)
	}

	transcript = strings.TrimSpace(textBuf.String())
	if transcript == "" {
		return "", nil, fmt.Errorf("STT trả về transcript rỗng — video có thể không có lời nói hoặc chất lượng âm thanh quá thấp")
	}
	return transcript, allSegs, nil
}

// transcribeChunk runs one STT request for a single audio chunk under its
// own STTRequestTimeout, emitting a progress heartbeat while it waits.
// It is the per-chunk unit used by runSTTAnalyze so that a long video is
// transcribed as a sequence of independently bounded requests. label (e.g.
// "phần 2/6 ") is prefixed to the progress message; pass "" for single-chunk
// videos.
func (s *transcriptionService) transcribeChunk(ctx context.Context, audioPath, label string, progress transcript.ProgressFn) (string, []transcriptSegment, error) {
	sttCtx, sttCancel := s.aiCtx(ctx, s.aiCfg.STTRequestTimeout)
	defer sttCancel()

	type sttResult struct {
		transcript string
		segments   []transcriptSegment
		err        error
	}
	resultCh := make(chan sttResult, 1)
	start := time.Now()
	go func() {
		t, segs, err := s.sttTranscribe(sttCtx, audioPath)
		resultCh <- sttResult{transcript: t, segments: segs, err: err}
	}()

	var progressC <-chan time.Time
	if iv := s.aiCfg.STTProgressInterval; iv > 0 {
		ticker := time.NewTicker(iv)
		defer ticker.Stop()
		progressC = ticker.C
	}

	for {
		select {
		case r := <-resultCh:
			return r.transcript, r.segments, r.err
		case <-progressC:
			elapsed := time.Since(start).Truncate(time.Second)
			msg := fmt.Sprintf("Đang phiên âm %sbằng STT (%s đã trôi qua)...", label, formatDuration(elapsed))
			if err := progress(richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, msg); err != nil {
				sttCancel()
				return "", nil, err
			}
		case <-ctx.Done():
			sttCancel()
			return "", nil, ctx.Err()
		}
	}
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
