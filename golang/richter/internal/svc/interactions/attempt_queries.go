package interactions

import (
	"context"
	"errors"
	"strings"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ── GetMyAttempt ──────────────────────────────────────────────────────────────

func (s *InteractionsSvc) GetMyAttempt(
	ctx context.Context,
	req *richterv1.GetMyAttemptRequest,
) (*richterv1.GetMyAttemptResponse, error) {
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

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	type result struct {
		attempt   gen.LessonAttempt
		responses []gen.ListAttemptResponsesRow
	}
	r, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (result, error) {
		a, err := q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{
			LessonID: lessonID,
			UserID:   userID,
		})
		if err != nil {
			return result{}, err
		}
		rs, err := q.ListAttemptResponses(ctx, a.ID)
		if err != nil {
			return result{}, err
		}
		return result{a, rs}, nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &richterv1.GetMyAttemptResponse{}, nil
		}
		return nil, svc.ConnectDBError(err)
	}

	return &richterv1.GetMyAttemptResponse{Attempt: AttemptToProto(r.attempt, r.responses)}, nil
}

func (s *InteractionsSvc) ListAttempts(
	ctx context.Context,
	req *richterv1.ListAttemptsRequest,
) (*richterv1.ListAttemptsResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner, gen.OrganizationRoleAdmin, gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	limit := req.GetLimit()
	if limit == 0 {
		limit = 50
	}

	type attemptsResult struct {
		rows  []gen.ListLessonAttemptsRow
		total int64
	}
	ar, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (attemptsResult, error) {
		rows, err := q.ListLessonAttempts(ctx, gen.ListLessonAttemptsParams{
			LessonID: lessonID, Limit: limit, Offset: req.GetOffset(),
		})
		if err != nil {
			return attemptsResult{}, err
		}
		total, err := q.CountLessonAttempts(ctx, lessonID)
		if err != nil {
			return attemptsResult{}, err
		}
		return attemptsResult{rows, total}, nil
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	summaries := make([]*richterv1.StudentAttemptSummary, 0, len(ar.rows))
	for _, r := range ar.rows {
		name := buildDisplayName(r.FirstName, r.MiddleName, r.LastName)
		var ts *timestamppb.Timestamp
		if r.SubmittedAt.Valid {
			ts = timestamppb.New(r.SubmittedAt.Time)
		}
		summaries = append(summaries, &richterv1.StudentAttemptSummary{
			UserId:       r.UserID.String(),
			DisplayName:  name,
			Email:        r.Email,
			TotalScore:   r.TotalScore,
			MaxScore:     r.MaxScore,
			SubmittedAt:  ts,
			AttemptCount: r.AttemptCount,
		})
	}

	return &richterv1.ListAttemptsResponse{
		Attempts: summaries,
		Total:    int32(ar.total),
	}, nil
}

func buildDisplayName(first string, middle pgtype.Text, last string) string {
	parts := []string{first}
	if middle.Valid && middle.String != "" {
		parts = append(parts, middle.String)
	}
	parts = append(parts, last)
	return strings.Join(parts, " ")
}
