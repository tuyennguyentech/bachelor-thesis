package interactions

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"
)

type singleGradeTarget struct {
	orgID         pgtype.UUID
	lesson        gen.Lesson
	interaction   gen.LessonInteraction
	interactionID pgtype.UUID
	responseJSON  []byte
	handler       Handler
}

type singleGradeResult struct {
	score    float32
	maxScore float32
	feedback string
}

// errPreviewGradePanicked is returned (in-band) by the PreviewGrade recover()
// branch so the surrounding error-handling code path can convert it into a
// graceful "pending" response.
var errPreviewGradePanicked = errors.New("PreviewGrade panicked")

func (s *InteractionsSvc) lookupSingleGradeTarget(
	ctx context.Context,
	lessonID pgtype.UUID,
	respInput *richterv1.AttemptResponseInput,
) (singleGradeTarget, error) {
	if respInput == nil {
		return singleGradeTarget{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("response required"))
	}
	interactionID, err := svc.ParseUUID(respInput.GetInteractionId())
	if err != nil {
		return singleGradeTarget{}, err
	}

	type lookup struct {
		orgID       pgtype.UUID
		lesson      gen.Lesson
		interaction gen.LessonInteraction
	}
	got, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (lookup, error) {
		orgID, err := q.GetOrgIDByLessonID(ctx, lessonID)
		if err != nil {
			return lookup{}, err
		}
		lesson, err := q.GetLessonByID(ctx, lessonID)
		if err != nil {
			return lookup{}, err
		}
		interaction, err := q.GetLessonInteractionByID(ctx, interactionID)
		if err != nil {
			return lookup{}, err
		}
		return lookup{orgID: orgID, lesson: lesson, interaction: interaction}, nil
	})
	if err != nil {
		return singleGradeTarget{}, svc.ConnectDBError(err)
	}
	if got.interaction.LessonID.String() != lessonID.String() {
		return singleGradeTarget{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("interaction does not belong to lesson"))
	}

	kind := dbStringToKind(got.interaction.Kind)
	h := Get(kind)
	if h == nil {
		return singleGradeTarget{}, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no handler for interaction kind %q", got.interaction.Kind))
	}
	responseJSON, err := h.ResponseProtoToJSON(respInput)
	if err != nil {
		return singleGradeTarget{}, err
	}

	return singleGradeTarget{
		orgID:         got.orgID,
		lesson:        got.lesson,
		interaction:   got.interaction,
		interactionID: interactionID,
		responseJSON:  responseJSON,
		handler:       h,
	}, nil
}

func (s *InteractionsSvc) gradeSingleResponse(
	ctx context.Context,
	lessonID pgtype.UUID,
	target singleGradeTarget,
) (result singleGradeResult, err error) {
	gradeCtx, cancel := s.aiCtx(ctx, s.intCfg.GradingTimeout)
	defer cancel()

	defer func() {
		if r := recover(); r != nil {
			s.log.ErrorContext(ctx, "interactions: panic in single response grade",
				"interaction_id", target.interactionID.String(), "recover", r)
			err = errPreviewGradePanicked
		}
	}()

	if cg, ok := target.handler.(ContextualGrader); ok && s.gradingDeps != nil {
		deps, derr := s.gradingDeps(gradeCtx, lessonID)
		if derr != nil {
			return singleGradeResult{}, fmt.Errorf("resolve grading deps: %w", derr)
		}
		score, maxScore, feedback, gerr := cg.GradeWithContext(gradeCtx, deps, target.interaction.Config, target.responseJSON)
		return singleGradeResult{score: score, maxScore: maxScore, feedback: feedback}, gerr
	}

	score, maxScore, feedback, gerr := target.handler.Grade(target.interaction.Config, target.responseJSON)
	return singleGradeResult{score: score, maxScore: maxScore, feedback: feedback}, gerr
}

func (s *InteractionsSvc) cacheGrade(claimsSub string, lessonID pgtype.UUID, interactionID string, responseJSON []byte, result singleGradeResult) {
	if s.kv == nil {
		return
	}
	cacheData := &richterv1.FdbTempGradeCache{
		ResponsePayload: responseJSON,
		Score:           result.score,
		MaxScore:        result.maxScore,
		Feedback:        result.feedback,
	}
	if cacheBytes, err := proto.Marshal(cacheData); err == nil {
		_ = s.kv.Set("temp_grade", tuple.Tuple{claimsSub, lessonID.String(), interactionID}, cacheBytes)
	}
}
