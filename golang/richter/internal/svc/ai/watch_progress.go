package ai

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
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
