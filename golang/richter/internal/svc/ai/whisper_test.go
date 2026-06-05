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
	audioBytes, err := extractAudio(ctx, tmp.Name())
	if err != nil {
		t.Fatalf("extractAudio: %v", err)
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

// TestWhisperResponseShape verifies that the verbose_json response from the
// faster-whisper-server is parsed into transcript text and segment timestamps.
// This is a pure struct / JSON unit test — no network call is made.
func TestWhisperResponseShape(t *testing.T) {
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
