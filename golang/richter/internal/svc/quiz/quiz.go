package quiz

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
	"google.golang.org/protobuf/types/known/timestamppb"
)

var Package = do.Package(
	do.Lazy(NewQuizSvc),
)

func init() {
	Package(internal.Injector)
}

type QuizSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.QuizServiceHandler = (*QuizSvc)(nil)

func NewQuizSvc(i do.Injector) (*QuizSvc, error) {
	pg, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc: %w", err)
	}
	l, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc: %w", err)
	}
	az, err := do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc: %w", err)
	}
	return &QuizSvc{pg: pg, log: l, authz: az}, nil
}

func (s *QuizSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewQuizServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

// ── SubmitQuiz ────────────────────────────────────────────────────────────────

func (s *QuizSvc) SubmitQuiz(
	ctx context.Context,
	req *richterv1.SubmitQuizRequest,
) (*richterv1.SubmitQuizResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}

	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.Sub)
	if err != nil {
		return nil, err
	}

	// Load questions to compute score
	questions, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonQuestion, error) {
		return q.ListLessonQuestions(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if len(questions) == 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("lesson has no questions"))
	}

	answers := req.GetAnswers()
	score := int32(0)
	total := int32(len(questions))
	for i, q := range questions {
		if i < len(answers) && answers[i] == q.CorrectAnswer {
			score++
		}
	}

	answersJSON, err := json.Marshal(answers)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	attempt, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.QuizAttempt, error) {
		return q.UpsertQuizAttempt(ctx, gen.UpsertQuizAttemptParams{
			LessonID: lessonID,
			UserID:   userID,
			Answers:  answersJSON,
			Score:    score,
			Total:    total,
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	return &richterv1.SubmitQuizResponse{Attempt: attemptToProto(attempt, answers)}, nil
}

// ── GetMyQuizAttempt ──────────────────────────────────────────────────────────

func (s *QuizSvc) GetMyQuizAttempt(
	ctx context.Context,
	req *richterv1.GetMyQuizAttemptRequest,
) (*richterv1.GetMyQuizAttemptResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}

	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.Sub)
	if err != nil {
		return nil, err
	}

	attempt, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.QuizAttempt, error) {
		return q.GetMyQuizAttempt(ctx, gen.GetMyQuizAttemptParams{
			LessonID: lessonID,
			UserID:   userID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &richterv1.GetMyQuizAttemptResponse{}, nil
		}
		return nil, svc.ConnectDBError(err)
	}

	var answers []int32
	_ = json.Unmarshal(attempt.Answers, &answers)
	return &richterv1.GetMyQuizAttemptResponse{Attempt: attemptToProto(attempt, answers)}, nil
}

// ── ListLessonAttempts ────────────────────────────────────────────────────────

func (s *QuizSvc) ListLessonAttempts(
	ctx context.Context,
	req *richterv1.ListLessonAttemptsRequest,
) (*richterv1.ListLessonAttemptsResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}

	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}

	limit := req.GetLimit()
	if limit == 0 {
		limit = 50
	}

	rows, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListLessonAttemptsRow, error) {
		return q.ListLessonAttempts(ctx, gen.ListLessonAttemptsParams{
			LessonID: lessonID,
			Limit:    limit,
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	total, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.CountLessonAttempts(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	results := make([]*richterv1.StudentAttemptResult, 0, len(rows))
	for _, r := range rows {
		name := buildDisplayName(r.FirstName, r.MiddleName, r.LastName)
		var ts *timestamppb.Timestamp
		if r.SubmittedAt.Valid {
			ts = timestamppb.New(r.SubmittedAt.Time)
		}
		results = append(results, &richterv1.StudentAttemptResult{
			UserId:      r.UserID.String(),
			DisplayName: name,
			Email:       r.Email,
			Score:       r.Score,
			Total:       r.Total,
			SubmittedAt: ts,
		})
	}

	return &richterv1.ListLessonAttemptsResponse{
		Attempts: results,
		Total:    int32(total),
	}, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func attemptToProto(a gen.QuizAttempt, answers []int32) *richterv1.QuizAttempt {
	var ts *timestamppb.Timestamp
	if a.SubmittedAt.Valid {
		ts = timestamppb.New(a.SubmittedAt.Time)
	}
	return &richterv1.QuizAttempt{
		Id:          a.ID.String(),
		LessonId:    a.LessonID.String(),
		UserId:      a.UserID.String(),
		Answers:     answers,
		Score:       a.Score,
		Total:       a.Total,
		SubmittedAt: ts,
	}
}

func buildDisplayName(first string, middle pgtype.Text, last string) string {
	parts := []string{first}
	if middle.Valid && middle.String != "" {
		parts = append(parts, middle.String)
	}
	parts = append(parts, last)
	return strings.Join(parts, " ")
}
