package storage

import "testing"

func TestIsStudentRecordingKey(t *testing.T) {
	cases := []struct {
		key  string
		want bool
	}{
		{"lessons/abc-123/student-recordings/rec-1.webm", true},
		{"lessons/abc-123/student-recordings/nested/rec-1.webm", true},
		{"lessons/abc-123/video.mp4", false},
		{"lessons/abc-123/audio-1234.mp3", false},
		{"seed/my-org/file.png", false},
		{"student-recordings/abc/rec.webm", false}, // legacy path — no longer recognised
		{"lessons//student-recordings/x.webm", true},
	}
	for _, c := range cases {
		if got := isStudentRecordingKey(c.key); got != c.want {
			t.Errorf("isStudentRecordingKey(%q): want %v, got %v", c.key, c.want, got)
		}
	}
}
