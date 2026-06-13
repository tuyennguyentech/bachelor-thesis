package ai

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestExtractAudioFromMP4 verifies that extractAudio produces valid 16kHz mono WAV
// from the educational test video. Requires ffmpeg in PATH.
func TestExtractAudioFromMP4(t *testing.T) {
	t.Parallel()
	const videoPath = "../../../testdata/edu-sample.mp4"
	if _, err := os.Stat(videoPath); os.IsNotExist(err) {
		t.Skipf("test video not found at %s — run generation script in testdata/README.md", videoPath)
	}

	// Copy the test video to a temp file so extractAudio operates on a path.
	// (The production path no longer loads the whole file into memory.)
	tmp, err := os.CreateTemp("", "richter-test-video-*.mp4")
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	defer os.Remove(tmp.Name())
	src, err := os.ReadFile(videoPath)
	if err != nil {
		t.Fatalf("read test video: %v", err)
	}
	if _, err := tmp.Write(src); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatalf("close temp: %v", err)
	}

	ctx := context.Background()
	// extractAudio now streams to a temp WAV file and returns its path.
	audioPath, err := extractAudio(ctx, tmp.Name(), t.TempDir())
	if err != nil {
		t.Fatalf("extractAudio: %v", err)
	}
	defer os.Remove(audioPath)
	audioBytes, err := os.ReadFile(audioPath)
	if err != nil {
		t.Fatalf("read extracted audio: %v", err)
	}

	if len(audioBytes) < 44 {
		t.Fatalf("WAV output too short: %d bytes", len(audioBytes))
	}
	// WAV magic: "RIFF" at offset 0, "WAVE" at offset 8.
	if string(audioBytes[0:4]) != "RIFF" {
		t.Errorf("expected RIFF header, got %q", audioBytes[0:4])
	}
	if string(audioBytes[8:12]) != "WAVE" {
		t.Errorf("expected WAVE format, got %q", audioBytes[8:12])
	}
	// Sample rate: little-endian uint32 at offset 24.
	sampleRate := binary.LittleEndian.Uint32(audioBytes[24:28])
	if sampleRate != 16000 {
		t.Errorf("sample rate: want 16000, got %d", sampleRate)
	}
	// Channels: little-endian uint16 at offset 22.
	numChannels := binary.LittleEndian.Uint16(audioBytes[22:24])
	if numChannels != 1 {
		t.Errorf("channels: want 1 (mono), got %d", numChannels)
	}
	t.Logf("extracted %d bytes of 16kHz mono WAV", len(audioBytes))
}

// TestSTTResponseShape verifies that the verbose_json response from the
// faster-whisper-server is parsed into transcript text and segment timestamps.
// This is a pure struct / JSON unit test — no network call is made.
func TestSTTResponseShape(t *testing.T) {
	t.Parallel()
	raw := `{
		"text": "  Binary search is efficient.  ",
		"segments": [
			{"start": 0.0, "end": 5.2, "text": " Binary search"},
			{"start": 5.2, "end": 10.0, "text": " is efficient."}
		]
	}`

	var result struct {
		Text     string `json:"text"`
		Segments []struct {
			Start float32 `json:"start"`
			End   float32 `json:"end"`
			Text  string  `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	transcript := strings.TrimSpace(result.Text)
	if transcript != "Binary search is efficient." {
		t.Errorf("transcript: want %q, got %q", "Binary search is efficient.", transcript)
	}
	if len(result.Segments) != 2 {
		t.Fatalf("segments: want 2, got %d", len(result.Segments))
	}
	if result.Segments[0].Start != 0.0 || result.Segments[0].End != 5.2 {
		t.Errorf("seg[0] time: want [0.0, 5.2], got [%f, %f]", result.Segments[0].Start, result.Segments[0].End)
	}
	if strings.TrimSpace(result.Segments[0].Text) != "Binary search" {
		t.Errorf("seg[0].text: want %q, got %q", "Binary search", strings.TrimSpace(result.Segments[0].Text))
	}
}

// TestExtractAudioSegments verifies that the video audio is split into
// multiple time-bounded WAV chunks (the long-video path) and that each chunk
// is a valid 16 kHz mono WAV. Uses a small segment_seconds so the short test
// video yields more than one chunk. Requires ffmpeg in PATH.
func TestExtractAudioSegments(t *testing.T) {
	t.Parallel()
	const videoPath = "../../../testdata/edu-sample.mp4"
	if _, err := os.Stat(videoPath); os.IsNotExist(err) {
		t.Skipf("test video not found at %s — run generation script in testdata/README.md", videoPath)
	}

	ctx := context.Background()
	outDir := t.TempDir()
	// 2-second segments force the short sample into several chunks.
	chunks, err := extractAudioSegments(ctx, videoPath, outDir, 2)
	if err != nil {
		t.Fatalf("extractAudioSegments: %v", err)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected multiple segments for a multi-second video, got %d", len(chunks))
	}

	var total float64
	for i, ch := range chunks {
		b, err := os.ReadFile(ch)
		if err != nil {
			t.Fatalf("read chunk %d: %v", i, err)
		}
		if len(b) < wavHeaderBytes || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
			t.Errorf("chunk %d is not a valid WAV (len=%d)", i, len(b))
		}
		if got := binary.LittleEndian.Uint32(b[24:28]); got != 16000 {
			t.Errorf("chunk %d sample rate: want 16000, got %d", i, got)
		}
		d := wavDurationSeconds(ch)
		if d <= 0 {
			t.Errorf("chunk %d duration: want > 0, got %f", i, d)
		}
		total += d
	}
	// Sum of chunk durations should reconstruct the full audio length (a few
	// seconds for edu-sample). Sanity-check it is non-trivial.
	if total < 1.0 {
		t.Errorf("summed chunk duration too small: %f s", total)
	}
	t.Logf("split into %d chunks, total %.2fs", len(chunks), total)
}

// TestExtractAudioSegmentsSingle verifies that segment_seconds <= 0 falls back
// to a single full-length extraction (one chunk), preserving legacy behavior.
func TestExtractAudioSegmentsSingle(t *testing.T) {
	t.Parallel()
	const videoPath = "../../../testdata/edu-sample.mp4"
	if _, err := os.Stat(videoPath); os.IsNotExist(err) {
		t.Skipf("test video not found at %s", videoPath)
	}
	chunks, err := extractAudioSegments(context.Background(), videoPath, t.TempDir(), 0)
	if err != nil {
		t.Fatalf("extractAudioSegments(0): %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("segment_seconds=0 should yield exactly 1 chunk, got %d", len(chunks))
	}
}
