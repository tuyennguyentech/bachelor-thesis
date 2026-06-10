package ai

import (
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// lessonTaskRecord is the in-memory shape of a task. The wire/storage
// shape is FdbLessonTaskRecord (protobuf) so we never touch JSON at the
// FDB boundary; see toFdbLessonTaskRecord / fromFdbLessonTaskRecord.
type lessonTaskRecord struct {
	ID              string
	LessonID        string
	ChunkID         string
	Kind            richterv1.LessonTaskKind
	Status          richterv1.LessonTaskStatus
	ProgressStep    string
	ProgressCurrent int32
	ProgressTotal   int32
	Message         string
	ErrorMsg        string
	// RequestPayload is the raw protobuf encoding of the per-kind request
	// (e.g. GenerateInteractionsRequest). Empty when no payload is needed.
	RequestPayload []byte
	CreatedBy      string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	StartedAt      time.Time
	FinishedAt     time.Time
}

func marshalLessonTaskRecord(rec lessonTaskRecord) ([]byte, error) {
	return proto.Marshal(toFdbLessonTaskRecord(rec))
}

// toFdbLessonTaskRecord converts the in-memory lessonTaskRecord to its
// protobuf wire form. Empty time.Time values are dropped to keep the
// proto encoding compact and so protobuf round-trip preserves the
// "unset" semantics the in-memory type carries.
func toFdbLessonTaskRecord(rec lessonTaskRecord) *richterv1.FdbLessonTaskRecord {
	out := &richterv1.FdbLessonTaskRecord{
		Id:              rec.ID,
		LessonId:        rec.LessonID,
		ChunkId:         rec.ChunkID,
		Kind:            int32(rec.Kind),
		Status:          int32(rec.Status),
		ProgressStep:    rec.ProgressStep,
		ProgressCurrent: rec.ProgressCurrent,
		ProgressTotal:   rec.ProgressTotal,
		Message:         rec.Message,
		ErrorMsg:        rec.ErrorMsg,
		RequestPayload:  rec.RequestPayload,
		CreatedBy:       rec.CreatedBy,
		CreatedAt:       timestamppb.New(rec.CreatedAt),
		UpdatedAt:       timestamppb.New(rec.UpdatedAt),
	}
	if !rec.StartedAt.IsZero() {
		out.StartedAt = timestamppb.New(rec.StartedAt)
	}
	if !rec.FinishedAt.IsZero() {
		out.FinishedAt = timestamppb.New(rec.FinishedAt)
	}
	return out
}

// fromFdbLessonTaskRecord decodes FDB bytes into the in-memory shape.
// Returns (zero, false) on a malformed payload so callers can treat
// corruption as "skip this row" without panicking.
func fromFdbLessonTaskRecord(data []byte) (lessonTaskRecord, bool) {
	if len(data) == 0 {
		return lessonTaskRecord{}, false
	}
	frec := &richterv1.FdbLessonTaskRecord{}
	if err := proto.Unmarshal(data, frec); err != nil {
		return lessonTaskRecord{}, false
	}
	rec := lessonTaskRecord{
		ID:              frec.GetId(),
		LessonID:        frec.GetLessonId(),
		ChunkID:         frec.GetChunkId(),
		Kind:            richterv1.LessonTaskKind(frec.GetKind()),
		Status:          richterv1.LessonTaskStatus(frec.GetStatus()),
		ProgressStep:    frec.GetProgressStep(),
		ProgressCurrent: frec.GetProgressCurrent(),
		ProgressTotal:   frec.GetProgressTotal(),
		Message:         frec.GetMessage(),
		ErrorMsg:        frec.GetErrorMsg(),
		RequestPayload:  frec.GetRequestPayload(),
		CreatedBy:       frec.GetCreatedBy(),
	}
	if ts := frec.GetCreatedAt(); ts != nil {
		rec.CreatedAt = ts.AsTime()
	}
	if ts := frec.GetUpdatedAt(); ts != nil {
		rec.UpdatedAt = ts.AsTime()
	}
	if ts := frec.GetStartedAt(); ts != nil {
		rec.StartedAt = ts.AsTime()
	}
	if ts := frec.GetFinishedAt(); ts != nil {
		rec.FinishedAt = ts.AsTime()
	}
	return rec, true
}
