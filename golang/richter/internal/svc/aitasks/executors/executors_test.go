package executors

import (
	"testing"

	richterv1 "example.com/buf/gen/richter/v1"
	"google.golang.org/protobuf/proto"
)

func TestParseUUID(t *testing.T) {
	tests := []struct {
		input string
		want  bool // true = no error
	}{
		{"550e8400-e29b-41d4-a716-446655440000", true},
		{"", false},
		{"not-a-uuid", false},
	}
	for _, tt := range tests {
		_, err := parseUUID(tt.input)
		got := err == nil
		if got != tt.want {
			t.Errorf("parseUUID(%q): got err=%v, want ok=%v", tt.input, err, tt.want)
		}
	}
}

func TestTranscribeInputProtoRoundtrip(t *testing.T) {
	in := &richterv1.TranscribeTaskInput{LessonId: "550e8400-e29b-41d4-a716-446655440000"}
	b, err := proto.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out richterv1.TranscribeTaskInput
	if err := proto.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.LessonId != in.LessonId {
		t.Errorf("LessonId = %q, want %q", out.LessonId, in.LessonId)
	}
}

func TestChunkInputProtoRoundtrip(t *testing.T) {
	in := &richterv1.ChunkTaskInput{LessonId: "550e8400-e29b-41d4-a716-446655440000"}
	b, err := proto.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out richterv1.ChunkTaskInput
	if err := proto.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.LessonId != in.LessonId {
		t.Errorf("LessonId = %q, want %q", out.LessonId, in.LessonId)
	}
}

func TestQuizGenInputProtoRoundtrip(t *testing.T) {
	in := &richterv1.QuizGenTaskInput{
		LessonId:        "550e8400-e29b-41d4-a716-446655440000",
		ChunkId:         "660e8400-e29b-41d4-a716-446655440001",
		ForceRegenerate: true,
		Difficulty:      "hard",
		FocusPrompt:     "focus on basics",
		CountPerChunk:   5,
	}
	b, err := proto.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out richterv1.QuizGenTaskInput
	if err := proto.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.LessonId != in.LessonId {
		t.Errorf("LessonId = %q, want %q", out.LessonId, in.LessonId)
	}
	if out.ChunkId != in.ChunkId {
		t.Errorf("ChunkId = %q, want %q", out.ChunkId, in.ChunkId)
	}
	if out.ForceRegenerate != true {
		t.Errorf("ForceRegenerate = %v, want true", out.ForceRegenerate)
	}
	if out.Difficulty != "hard" {
		t.Errorf("Difficulty = %q, want %q", out.Difficulty, "hard")
	}
	if out.FocusPrompt != "focus on basics" {
		t.Errorf("FocusPrompt = %q, want %q", out.FocusPrompt, "focus on basics")
	}
	if out.CountPerChunk != 5 {
		t.Errorf("CountPerChunk = %d, want 5", out.CountPerChunk)
	}
}

// TestShouldForceGen guards the resume anti-duplication rule: force-regenerate
// must only apply when the chunk stage actually (re)ran this run, otherwise a
// resume that skipped chunking would DUPLICATE interactions.
func TestShouldForceGen(t *testing.T) {
	cases := []struct {
		name  string
		force bool
		done  richterv1.PipelineStage
		want  bool
	}{
		{"fresh run forces (chunk stage ran)", true, richterv1.PipelineStage_PIPELINE_STAGE_UNSPECIFIED, true},
		{"resume after transcribe forces (chunk will run)", true, richterv1.PipelineStage_PIPELINE_STAGE_TRANSCRIBED, true},
		{"resume past chunk must NOT force (avoid dup)", true, richterv1.PipelineStage_PIPELINE_STAGE_CHUNKED, false},
		{"resume past generate must NOT force", true, richterv1.PipelineStage_PIPELINE_STAGE_GENERATED, false},
		{"force off never forces", false, richterv1.PipelineStage_PIPELINE_STAGE_UNSPECIFIED, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldForceGen(tc.force, tc.done); got != tc.want {
				t.Errorf("shouldForceGen(%v, %v) = %v, want %v", tc.force, tc.done, got, tc.want)
			}
		})
	}
}
