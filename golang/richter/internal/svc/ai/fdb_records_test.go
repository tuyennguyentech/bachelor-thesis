package ai

import (
	"bytes"
	"testing"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"google.golang.org/protobuf/proto"
)

func TestFdbTranscriptRecordRoundTrip(t *testing.T) {
	want := &richterv1.FdbTranscript{
		Text:     "CI/CD pipeline keeps releases repeatable.",
		Language: "vi",
	}
	data, err := proto.Marshal(want)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := &richterv1.FdbTranscript{}
	if err := proto.Unmarshal(data, got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !proto.Equal(want, got) {
		t.Fatalf("round-trip mismatch:\nwant=%v\ngot=%v", want, got)
	}
}

func TestFdbSegmentsBlobRecordRoundTrip(t *testing.T) {
	want := &richterv1.FdbSegmentsBlob{Segments: []*richterv1.FdbTranscriptSegment{
		{StartSeconds: 0, EndSeconds: 4.5, Text: "Workflow bắt đầu bằng trigger."},
		{StartSeconds: 4.5, EndSeconds: 9, Text: "Job chứa nhiều step."},
	}}
	data, err := proto.Marshal(want)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := &richterv1.FdbSegmentsBlob{}
	if err := proto.Unmarshal(data, got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !proto.Equal(want, got) {
		t.Fatalf("round-trip mismatch:\nwant=%v\ngot=%v", want, got)
	}
}

func TestFdbLessonTaskRecordRoundTrip(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	want := lessonTaskRecord{
		ID:              "task-1",
		LessonID:        "lesson-1",
		ChunkID:         "chunk-1",
		Kind:            richterv1.LessonTaskKind_LESSON_TASK_KIND_GENERATE_INTERACTIONS,
		Status:          richterv1.LessonTaskStatus_LESSON_TASK_STATUS_RUNNING,
		ProgressStep:    "GENERATING",
		ProgressCurrent: 2,
		ProgressTotal:   5,
		Message:         "Đang tạo bài tập.",
		ErrorMsg:        "",
		RequestPayload:  []byte{0x0a, 0x08, 'l', 'e', 's', 's', 'o', 'n', '-', '1'},
		CreatedBy:       "user-1",
		CreatedAt:       now,
		UpdatedAt:       now,
		StartedAt:       now,
	}
	data, err := proto.Marshal(toFdbLessonTaskRecord(want))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got, ok := fromFdbLessonTaskRecord(data)
	if !ok {
		t.Fatal("fromFdbLessonTaskRecord returned !ok")
	}
	if got.ID != want.ID ||
		got.LessonID != want.LessonID ||
		got.ChunkID != want.ChunkID ||
		got.Kind != want.Kind ||
		got.Status != want.Status ||
		got.ProgressStep != want.ProgressStep ||
		got.ProgressCurrent != want.ProgressCurrent ||
		got.ProgressTotal != want.ProgressTotal ||
		got.Message != want.Message ||
		got.ErrorMsg != want.ErrorMsg ||
		!bytes.Equal(got.RequestPayload, want.RequestPayload) ||
		got.CreatedBy != want.CreatedBy ||
		!got.CreatedAt.Equal(want.CreatedAt) ||
		!got.UpdatedAt.Equal(want.UpdatedAt) ||
		!got.StartedAt.Equal(want.StartedAt) {
		t.Fatalf("round-trip mismatch:\nwant=%+v\ngot=%+v", want, got)
	}
}

func TestFdbTempGradeCacheRecordRoundTrip(t *testing.T) {
	want := &richterv1.FdbTempGradeCache{
		ResponsePayload: []byte(`{"selected":1}`),
		Score:           0.75,
		MaxScore:        1,
		Feedback:        "Đúng một phần.",
	}
	data, err := proto.Marshal(want)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := &richterv1.FdbTempGradeCache{}
	if err := proto.Unmarshal(data, got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !proto.Equal(want, got) {
		t.Fatalf("round-trip mismatch:\nwant=%v\ngot=%v", want, got)
	}
}
