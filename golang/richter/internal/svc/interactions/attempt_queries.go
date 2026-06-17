package interactions

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

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
		var watchFrac float64
		if r.VideoWatchFraction.Valid {
			watchFrac = float64(r.VideoWatchFraction.Float32)
		}
		// response_rate: actual responses submitted / total interactions available.
		// Kept on the proto for completeness; no longer feeds engagement (it is
		// ~always 1.0 since answering is required to submit).
		responseRate := float64(0)
		if r.TotalInteractions > 0 {
			responseRate = float64(r.ResponseCount) / float64(r.TotalInteractions)
		}
		scoreFrac := float64(0)
		if r.MaxScore > 0 {
			scoreFrac = float64(r.TotalScore) / float64(r.MaxScore)
		}
		eng := computeEngagementScore(watchFrac, scoreFrac)
		summaries = append(summaries, &richterv1.StudentAttemptSummary{
			UserId:             r.UserID.String(),
			DisplayName:        name,
			Email:              r.Email,
			TotalScore:         r.TotalScore,
			MaxScore:           r.MaxScore,
			SubmittedAt:        ts,
			AttemptCount:       r.AttemptCount,
			AvgTimeToAnswerMs:  r.AvgTimeToAnswerMs,
			VideoWatchFraction: watchFrac,
			EngagementScore:    eng,
			TimeOnTaskMs:       r.TimeOnTaskMs,
			ResponseRate:       responseRate,
			AvgReplayCount:     r.AvgReplayCount,
		})
	}

	return &richterv1.ListAttemptsResponse{
		Attempts: summaries,
		Total:    int32(ar.total),
	}, nil
}

// ── ListCourseAttemptsSummary ─────────────────────────────────────────────────

func (s *InteractionsSvc) ListCourseAttemptsSummary(
	ctx context.Context,
	req *richterv1.ListCourseAttemptsSummaryRequest,
) (*richterv1.ListCourseAttemptsSummaryResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}

	// Resolve org ID for the course to enforce teacher/admin authz.
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		course, err := q.GetCourseByID(ctx, courseID)
		if err != nil {
			return pgtype.UUID{}, err
		}
		return course.OrganizationID, nil
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

	type analyticsResult struct {
		rows  []gen.ListCourseAttemptsSummaryRow
		total int64
	}
	ar, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (analyticsResult, error) {
		rows, err := q.ListCourseAttemptsSummary(ctx, gen.ListCourseAttemptsSummaryParams{
			CourseID: courseID,
			Limit:    limit,
			Offset:   req.GetOffset(),
		})
		if err != nil {
			return analyticsResult{}, err
		}
		total, err := q.CountCourseAttemptStudents(ctx, courseID)
		if err != nil {
			return analyticsResult{}, err
		}
		return analyticsResult{rows, total}, nil
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	students := make([]*richterv1.CourseStudentSummary, 0, len(ar.rows))
	for _, r := range ar.rows {
		eng := computeEngagementScore(
			r.AvgVideoWatchFraction,
			r.AvgScore,
		)
		var lastActive *timestamppb.Timestamp
		if t, ok := r.LastActive.(time.Time); ok && !t.IsZero() {
			lastActive = timestamppb.New(t)
		}
		students = append(students, &richterv1.CourseStudentSummary{
			UserId:                r.UserID.String(),
			DisplayName:           buildDisplayName(r.FirstName, r.MiddleName, r.LastName),
			Email:                 r.Email,
			LessonsCompleted:      r.LessonsCompleted,
			LessonsTotal:          r.LessonsTotal,
			AvgScore:              r.AvgScore,
			AvgVideoWatchFraction: r.AvgVideoWatchFraction,
			EngagementScore:       eng,
			LastActive:            lastActive,
			ResponseRate:          r.ResponseRate,
			TotalScore:            r.TotalScore,
			TotalMaxScore:         r.TotalMaxScore,
			TotalResponses:        r.TotalResponses,
			TotalInteractions:     r.TotalInteractions,
			TotalTimeMs:           r.TotalTimeMs,
		})
	}

	return &richterv1.ListCourseAttemptsSummaryResponse{
		Students: students,
		Total:    ar.total,
	}, nil
}

// ── ListMyCourseProgress ──────────────────────────────────────────────────────

func (s *InteractionsSvc) ListMyCourseProgress(
	ctx context.Context,
	req *richterv1.ListMyCourseProgressRequest,
) (*richterv1.ListMyCourseProgressResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.Sub)
	if err != nil {
		return nil, err
	}

	limit := req.GetLimit()
	if limit == 0 {
		limit = 50
	}

	rows, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListMyCourseProgressRow, error) {
		return q.ListMyCourseProgress(ctx, gen.ListMyCourseProgressParams{
			UserID: userID,
			Limit:  limit,
			Offset: req.GetOffset(),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	courses := make([]*richterv1.MyCourseProgress, 0, len(rows))
	for _, r := range rows {
		courses = append(courses, &richterv1.MyCourseProgress{
			CourseId:    r.CourseID.String(),
			Title:       r.Title,
			LessonsDone: r.LessonsDone,
			LessonsTotal: r.LessonsTotal,
			AvgScore:    r.AvgScore,
		})
	}

	return &richterv1.ListMyCourseProgressResponse{Courses: courses}, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// computeEngagementScore returns a composite 0–100 engagement score.
// Formula: round(100 * (0.5*watch + 0.5*scoreFrac))
// Each input is clamped to [0, 1]; divide-by-zero is guarded by callers passing 0.
//
// Response rate (answered/total) is deliberately NOT an input: questions are
// answered to submit, so it is ~always 1.0 and only added a constant offset that
// inflated every score. Engagement now reflects what varies — how much of the
// video was watched and how well the learner scored.
func computeEngagementScore(watch, scoreFrac float64) float64 {
	clamp := func(v float64) float64 {
		if v < 0 {
			return 0
		}
		if v > 1 {
			return 1
		}
		return v
	}
	raw := 0.5*clamp(watch) + 0.5*clamp(scoreFrac)
	return math.Round(100 * raw)
}

func buildDisplayName(first string, middle pgtype.Text, last string) string {
	parts := []string{first}
	if middle.Valid && middle.String != "" {
		parts = append(parts, middle.String)
	}
	parts = append(parts, last)
	return strings.Join(parts, " ")
}


