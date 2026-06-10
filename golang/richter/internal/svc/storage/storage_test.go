package storage

import (
	"testing"
)

func TestIsStudentRecordingKey(t *testing.T) {
	cases := []struct {
		name string
		key  string
		want bool
	}{
		{"webm recording", "lessons/abc-123/student-recordings/rec-1.webm", true},
		{"nested recording path", "lessons/abc-123/student-recordings/nested/rec-1.webm", true},
		{"ogg recording", "lessons/abc-123/student-recordings/r.ogg", true},
		{"teacher video is not recording", "lessons/abc-123/video.mp4", false},
		{"teacher audio asset is not recording", "lessons/abc-123/audio-1234.mp3", false},
		{"seed key is not recording", "seed/my-org/file.png", false},
		{"legacy path not recognised", "student-recordings/abc/rec.webm", false},
		{"empty lesson id is recording-shape only", "lessons//student-recordings/x.webm", true},
		{"disallowed extension .exe", "lessons/abc/student-recordings/malware.exe", false},
		{"disallowed extension no ext", "lessons/abc/student-recordings/notes", false},
		{"uppercase extension still allowed", "lessons/abc/student-recordings/rec.WEBM", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isStudentRecordingKey(c.key); got != c.want {
				t.Errorf("isStudentRecordingKey(%q): want %v, got %v", c.key, c.want, got)
			}
		})
	}
}

func TestValidateLessonKey(t *testing.T) {
	lessonID := "11111111-1111-1111-1111-111111111111"
	tests := []struct {
		name    string
		key     string
		wantID  string
		wantErr bool
	}{
		{"mp4 happy path", "lessons/" + lessonID + "/video.mp4", lessonID, false},
		{"nested video path", "lessons/" + lessonID + "/video/22222222-2222-2222-2222-222222222222.mp4", lessonID, false},
		{"mov happy path", "lessons/" + lessonID + "/intro.mov", lessonID, false},
		{"png asset", "lessons/" + lessonID + "/cover.png", lessonID, false},
		{"executable rejected", "lessons/" + lessonID + "/malware.exe", "", true},
		{"script rejected", "lessons/" + lessonID + "/payload.sh", "", true},
		{"no extension rejected", "lessons/" + lessonID + "/file", "", true},
		{"path traversal rejected", "lessons/" + lessonID + "/../secret.mp4", "", true},
		{"wrong prefix rejected", "media/" + lessonID + "/file.mp4", "", true},
		{"missing filename rejected", "lessons/" + lessonID + "/", "", true},
		{"missing lesson id rejected", "lessons//file.mp4", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotID, err := validateLessonKey(tt.key)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateLessonKey() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && gotID != tt.wantID {
				t.Errorf("lesson id: want %q, got %q", tt.wantID, gotID)
			}
		})
	}
}

func TestValidateSeedKey(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{"valid seed", "seed/my-org/cover.png", false},
		{"path traversal", "seed/my-org/../escape.png", true},
		{"missing org slug", "seed//cover.png", true},
		{"missing path", "seed/my-org", true},
		{"wrong prefix", "lessons/x/y.mp4", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := validateSeedKey(tt.key)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateSeedKey() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeStorageKeyNFC(t *testing.T) {
	// NFC normalizes canonical equivalence classes (NFD → NFC for combining
	// marks) so attackers cannot register two different encodings of the same
	// logical key. Look-alike fullwidth characters are NOT in NFC's canonical
	// mapping (they are precomposed, not decomposable) and are preserved as-is
	// — they reach the structural validator as plain runes and are rejected
	// by path.Clean, extension checks, etc.
	cases := []struct {
		name string
		in   string
		out  string
	}{
		{"already NFC is idempotent", "lessons/abc/file.mp4", "lessons/abc/file.mp4"},
		{"NFD combining acute gets composed", "lessons/abc/file\u0065\u0301.mp4", "lessons/abc/file\u00e9.mp4"},
		{"fullwidth slash preserved as plain rune", "lessons/abc/\uff0ffile.mp4", "lessons/abc/\uff0ffile.mp4"},
		{"fullwidth dot preserved as plain rune", "lessons/abc/file\uff0emp4", "lessons/abc/file\uff0emp4"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := normalizeStorageKey(c.in); got != c.out {
				t.Errorf("normalize(%q) = %q, want %q", c.in, got, c.out)
			}
		})
	}
}

func TestAllowStudentUploadDelegatesToLimiter(t *testing.T) {
	// StorageSvc must be a thin pass-through to the injected limiter; this
	// guarantees a future swap of the backing store (in-memory → FDB → Redis)
	// requires no business-logic changes.
	s := &StorageSvc{uploadLimiter: unlimitedUploadRateLimiter{}}
	if !s.allowStudentUpload("u", "lessons/L/student-recordings/x.webm") {
		t.Fatal("delegated unlimited limiter must allow")
	}
}
