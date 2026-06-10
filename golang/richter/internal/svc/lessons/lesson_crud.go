package lessons

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *LessonsSvc) CreateLesson(
	ctx context.Context,
	req *richterv1.CreateLessonRequest,
) (*richterv1.CreateLessonResponse, error) {
	module, err := s.fetchModule(ctx, req.GetModuleId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("CreateLesson.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("CreateLesson.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.CreateLesson(ctx, gen.CreateLessonParams{
			ModuleID:    module.ID,
			Title:       req.GetTitle(),
			Description: descToPgText(req.GetDescription()),
			OrderIndex:  req.GetOrderIndex(),
			MaxAttempts: req.GetMaxAttempts(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("CreateLesson", err)...)
		return nil, err
	}
	return &richterv1.CreateLessonResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) GetLessonById(
	ctx context.Context,
	req *richterv1.GetLessonByIdRequest,
) (*richterv1.GetLessonByIdResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	l, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		if connect.CodeOf(err) == connect.CodeNotFound && claims.GetRole() != richterv1.UserRole_USER_ROLE_ADMIN {
			return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("not a member of this organization"))
		}
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("GetLessonById", err)...)
		return nil, err
	}
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, l.ID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}
	return &richterv1.GetLessonByIdResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) ListLessons(
	ctx context.Context,
	req *richterv1.ListLessonsRequest,
) (*richterv1.ListLessonsResponse, error) {
	moduleID, err := svc.ParseUUID(req.GetModuleId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessons.ParseUUID", err)...)
		return nil, err
	}

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByCourseModuleID(ctx, moduleID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	ls, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
		return q.ListLessons(ctx, gen.ListLessonsParams{
			ModuleID: moduleID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessons", err)...)
		return nil, err
	}

	out := make([]*richterv1.Lesson, 0, len(ls))
	for _, l := range ls {
		out = append(out, LessonToProto(l))
	}
	return &richterv1.ListLessonsResponse{Lessons: out}, nil
}

func (s *LessonsSvc) ListLessonsByCourse(
	ctx context.Context,
	req *richterv1.ListLessonsByCourseRequest,
) (*richterv1.ListLessonsByCourseResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse.ParseUUID", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, courseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgMember(ctx, course.OrganizationID); err != nil {
		return nil, err
	}

	ls, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
		return q.ListLessonsByCourse(ctx, gen.ListLessonsByCourseParams{
			CourseID: courseID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse", err)...)
		return nil, err
	}

	out := make([]*richterv1.Lesson, 0, len(ls))
	for _, l := range ls {
		out = append(out, LessonToProto(l))
	}
	return &richterv1.ListLessonsByCourseResponse{Lessons: out}, nil
}

func (s *LessonsSvc) UpdateLesson(
	ctx context.Context,
	req *richterv1.UpdateLessonRequest,
) (*richterv1.UpdateLessonResponse, error) {
	existing, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson.fetch", err)...)
		return nil, err
	}
	module, err := s.fetchModule(ctx, existing.ModuleID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	lang := req.GetLanguage()
	if lang == "" {
		lang = existing.Language
	}
	maxAtt := req.GetMaxAttempts()
	if req.MaxAttempts == nil {
		maxAtt = existing.MaxAttempts
	}
	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.UpdateLesson(ctx, gen.UpdateLessonParams{
			ID:          existing.ID,
			Title:       req.GetTitle(),
			Description: descToPgText(req.GetDescription()),
			OrderIndex:  req.GetOrderIndex(),
			Language:    lang,
			MaxAttempts: maxAtt,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson", err)...)
		return nil, err
	}
	return &richterv1.UpdateLessonResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) UpdateLessonFeedbackMode(
	ctx context.Context,
	req *richterv1.UpdateLessonFeedbackModeRequest,
) (*richterv1.UpdateLessonFeedbackModeResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetId())
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
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}
	updated, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.UpdateLessonFeedbackMode(ctx, gen.UpdateLessonFeedbackModeParams{
			ID:           lessonID,
			FeedbackMode: FeedbackModeFromProto(req.GetFeedbackMode()),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateLessonFeedbackModeResponse{Lesson: LessonToProto(updated)}, nil
}
