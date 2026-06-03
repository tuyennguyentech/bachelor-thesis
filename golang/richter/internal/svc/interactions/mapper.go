package interactions

import (
	"log/slog"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// InteractionToProto converts a DB row to a proto LessonInteraction.
// If stripAnswers is true, correct answers and explanations are hidden.
func InteractionToProto(i gen.LessonInteraction, stripAnswers bool) *richterv1.LessonInteraction {
	kind := dbStringToKind(i.Kind)

	chunkID := ""
	if i.ChunkID.Valid {
		chunkID = i.ChunkID.String()
	}

	explanation := i.Explanation
	if stripAnswers {
		explanation = ""
	}

	p := &richterv1.LessonInteraction{
		Id:           i.ID.String(),
		LessonId:     i.LessonID.String(),
		ChunkId:      chunkID,
		StartSeconds: i.StartSeconds,
		OrderIndex:   i.OrderIndex,
		Kind:         kind,
		Prompt:       i.Prompt,
		Explanation:  explanation,
		MaxScore:     i.MaxScore,
		GeneratedBy:  i.GeneratedBy,
	}
	if i.CreatedAt.Valid {
		p.CreatedAt = timestamppb.New(i.CreatedAt.Time)
	}

	h := Get(kind)
	if h == nil {
		slog.Warn("interactions: no handler for kind", "kind", kind, "id", i.ID.String())
		return p
	}

	h.ApplyConfig(p, i.Config, stripAnswers)
	return p
}

// AttemptToProto converts a DB attempt + responses to a proto LessonAttempt.
func AttemptToProto(a gen.LessonAttempt, responses []gen.ListAttemptResponsesRow) *richterv1.LessonAttempt {
	protoResps := make([]*richterv1.LessonAttemptResponse, 0, len(responses))
	for _, r := range responses {
		kind := dbStringToKind(r.InteractionKind)
		h := Get(kind)
		if h == nil {
			continue
		}
		protoResps = append(protoResps, h.BuildResponseProto(
			r.InteractionID.String(),
			r.Response,
			r.Score,
			r.MaxScore,
			r.Feedback,
		))
	}

	var submittedAt *timestamppb.Timestamp
	if a.SubmittedAt.Valid {
		submittedAt = timestamppb.New(a.SubmittedAt.Time)
	}

	return &richterv1.LessonAttempt{
		Id:           a.ID.String(),
		LessonId:     a.LessonID.String(),
		UserId:       a.UserID.String(),
		TotalScore:   a.TotalScore,
		MaxScore:     a.MaxScore,
		Status:       a.Status,
		SubmittedAt:  submittedAt,
		Responses:    protoResps,
		AttemptCount: a.AttemptCount,
	}
}

// KindToDBString converts a proto InteractionKind to its database string representation.
func KindToDBString(kind richterv1.InteractionKind) string { return kindToDBString(kind) }

func kindToDBString(kind richterv1.InteractionKind) string {
	switch kind {
	case richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE:
		return "mcq"
	case richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE:
		return "multiple_choice"
	case richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK:
		return "fill_blank"
	case richterv1.InteractionKind_INTERACTION_KIND_LISTENING:
		return "listening"
	case richterv1.InteractionKind_INTERACTION_KIND_READING:
		return "reading"
	default:
		return "unknown"
	}
}

// DBStringToKind converts a database kind string to the proto InteractionKind.
func DBStringToKind(s string) richterv1.InteractionKind { return dbStringToKind(s) }

func dbStringToKind(s string) richterv1.InteractionKind {
	switch s {
	case "mcq":
		return richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE
	case "multiple_choice":
		return richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE
	case "fill_blank":
		return richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK
	case "listening":
		return richterv1.InteractionKind_INTERACTION_KIND_LISTENING
	case "reading":
		return richterv1.InteractionKind_INTERACTION_KIND_READING
	default:
		return richterv1.InteractionKind_INTERACTION_KIND_UNSPECIFIED
	}
}

// FeedbackModeToProto converts a DB feedback_mode string to the proto enum.
func FeedbackModeToProto(mode string) richterv1.FeedbackMode {
	switch mode {
	case "hidden":
		return richterv1.FeedbackMode_FEEDBACK_MODE_HIDDEN
	case "after_each":
		return richterv1.FeedbackMode_FEEDBACK_MODE_AFTER_EACH
	default:
		return richterv1.FeedbackMode_FEEDBACK_MODE_AFTER_SUBMIT
	}
}

// FeedbackModeFromProto converts the proto enum to a DB feedback_mode string.
func FeedbackModeFromProto(mode richterv1.FeedbackMode) string {
	switch mode {
	case richterv1.FeedbackMode_FEEDBACK_MODE_HIDDEN:
		return "hidden"
	case richterv1.FeedbackMode_FEEDBACK_MODE_AFTER_EACH:
		return "after_each"
	default:
		return "after_submit"
	}
}

// ShouldStripAnswers returns true when correct answers should be hidden from the caller.
func ShouldStripAnswers(feedbackMode string, isTeacher bool, hasSubmitted bool) bool {
	if isTeacher {
		return false
	}
	switch feedbackMode {
	case "hidden":
		return true
	case "after_each":
		return false
	default: // after_submit
		return !hasSubmitted
	}
}

// TimestamptzToProto converts a pgtype.Timestamptz to *timestamppb.Timestamp.
func TimestamptzToProto(t pgtype.Timestamptz) *timestamppb.Timestamp {
	if !t.Valid {
		return nil
	}
	return timestamppb.New(t.Time)
}
