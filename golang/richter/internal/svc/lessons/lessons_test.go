package lessons

import "testing"

func TestValidateLessonVideoKey(t *testing.T) {
	lessonID := "11111111-1111-1111-1111-111111111111"

	tests := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{
			name: "versioned video path",
			key:  "lessons/" + lessonID + "/video/22222222-2222-2222-2222-222222222222.mp4",
		},
		{
			name: "legacy video filename",
			key:  "lessons/" + lessonID + "/video.mp4",
		},
		{
			name:    "different lesson",
			key:     "lessons/33333333-3333-3333-3333-333333333333/video.mp4",
			wantErr: true,
		},
		{
			name:    "non video lesson asset",
			key:     "lessons/" + lessonID + "/slides/deck.pdf",
			wantErr: true,
		},
		{
			name:    "path traversal",
			key:     "lessons/" + lessonID + "/video/../secret.mp4",
			wantErr: true,
		},
		{
			name:    "empty filename",
			key:     "lessons/" + lessonID + "/",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateLessonVideoKey(lessonID, tt.key)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateLessonVideoKey() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
