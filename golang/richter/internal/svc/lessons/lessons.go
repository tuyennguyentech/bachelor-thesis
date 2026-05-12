package lessons

import (
	"context"
	"fmt"
	"net/http"

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
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewLessonsSvc),
)

func init() {
	Package(internal.Injector)
}

type LessonsSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.LessonServiceHandler = (*LessonsSvc)(nil)

func NewLessonsSvc(i do.Injector) (s *LessonsSvc, err error) {
	s = new(LessonsSvc)
	s.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	s.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	s.authz, err = do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	return
}

func (s *LessonsSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewLessonServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

func (s *LessonsSvc) fetchModule(ctx context.Context, id string) (gen.CourseModule, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.CourseModule{}, err
	}
	m, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseModule, error) {
		return q.GetCourseModuleByID(ctx, uuid)
	})
	if err != nil {
		return gen.CourseModule{}, svc.ConnectDBError(err)
	}
	return m, nil
}

func (s *LessonsSvc) fetchCourse(ctx context.Context, id pgtype.UUID) (gen.Course, error) {
	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.GetCourseByID(ctx, id)
	})
	if err != nil {
		return gen.Course{}, svc.ConnectDBError(err)
	}
	return course, nil
}

func (s *LessonsSvc) fetchLesson(ctx context.Context, id string) (gen.Lesson, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.Lesson{}, err
	}
	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, uuid)
	})
	if err != nil {
		return gen.Lesson{}, svc.ConnectDBError(err)
	}
	return l, nil
}

func (s *LessonsSvc) descToPgText(desc string) pgtype.Text {
	return pgtype.Text{String: desc, Valid: desc != ""}
}

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
			Description: s.descToPgText(req.GetDescription()),
			OrderIndex:  req.GetOrderIndex(),
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
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	l, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("GetLessonById", err)...)
		return nil, err
	}
	return &richterv1.GetLessonByIdResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) ListLessons(
	ctx context.Context,
	req *richterv1.ListLessonsRequest,
) (*richterv1.ListLessonsResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	moduleID, err := svc.ParseUUID(req.GetModuleId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessons.ParseUUID", err)...)
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
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse.ParseUUID", err)...)
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

	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.UpdateLesson(ctx, gen.UpdateLessonParams{
			ID:          existing.ID,
			Title:       req.GetTitle(),
			Description: s.descToPgText(req.GetDescription()),
			OrderIndex:  req.GetOrderIndex(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson", err)...)
		return nil, err
	}
	return &richterv1.UpdateLessonResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) UpdateLessonVideo(
	ctx context.Context,
	req *richterv1.UpdateLessonVideoRequest,
) (*richterv1.UpdateLessonVideoResponse, error) {
	existing, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo.fetch", err)...)
		return nil, err
	}
	module, err := s.fetchModule(ctx, existing.ModuleID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo.fetchCourse", err)...)
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
		return q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
			ID:              existing.ID,
			VideoStorageKey: pgtype.Text{String: req.GetVideoStorageKey(), Valid: true},
			DurationSeconds: pgtype.Int4{Int32: req.GetDurationSeconds(), Valid: req.GetDurationSeconds() > 0},
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo", err)...)
		return nil, err
	}
	return &richterv1.UpdateLessonVideoResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) DeleteLesson(
	ctx context.Context,
	req *richterv1.DeleteLessonRequest,
) (*richterv1.DeleteLessonResponse, error) {
	existing, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.fetch", err)...)
		return nil, err
	}
	module, err := s.fetchModule(ctx, existing.ModuleID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	rowsAffected, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.DeleteLesson(ctx, existing.ID)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("lesson not found: %s", existing.ID))
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.NotFound", err)...)
		return nil, err
	}
	return &richterv1.DeleteLessonResponse{}, nil
}
