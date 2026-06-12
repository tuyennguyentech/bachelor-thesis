package ai

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *AISvc) UpdateWatchProgress(
	ctx context.Context,
	req *richterv1.UpdateWatchProgressRequest,
) (*richterv1.UpdateWatchProgressResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	claims, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID)
	if err != nil {
		return nil, err
	}
	if err := s.kv.SetFloat64(kvNsWatch, tuple.Tuple{claims.GetSub(), lessonID.String()}, float64(req.GetPositionSeconds())); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("save watch progress: %w", err))
	}

	// Record server-authoritative watch coverage for the reported interval.
	// This feeds the honest video_watch_fraction computed at submit time.
	if req.GetWatchedToSeconds() > req.GetWatchedFromSeconds() {
		// Best-effort: load the lesson duration to clamp coverage. If the
		// lesson can't be loaded, pass 0 — AddWatchCoverage tolerates an
		// unknown duration (records bits unclamped on the high end).
		durationSec := 0
		if lesson, lerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
			return q.GetLessonByID(ctx, lessonID)
		}); lerr == nil && lesson.DurationSeconds.Valid {
			durationSec = int(lesson.DurationSeconds.Int32)
		}
		if cerr := kv.AddWatchCoverage(s.kv, claims.GetSub(), lessonID.String(),
			float64(req.GetWatchedFromSeconds()), float64(req.GetWatchedToSeconds()), durationSec); cerr != nil {
			// Coverage is best-effort telemetry; log-and-continue rather than
			// failing the position save the client depends on.
			s.log.WarnContext(ctx, "ai: add watch coverage failed",
				"lesson_id", lessonID.String(), "err", cerr)
		}
	}

	return &richterv1.UpdateWatchProgressResponse{}, nil
}

func (s *AISvc) GetWatchProgress(
	ctx context.Context,
	req *richterv1.GetWatchProgressRequest,
) (*richterv1.GetWatchProgressResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	claims, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID)
	if err != nil {
		return nil, err
	}
	pos, err := s.kv.GetFloat64(kvNsWatch, tuple.Tuple{claims.GetSub(), lessonID.String()})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("get watch progress: %w", err))
	}
	return &richterv1.GetWatchProgressResponse{PositionSeconds: float32(pos)}, nil
}
