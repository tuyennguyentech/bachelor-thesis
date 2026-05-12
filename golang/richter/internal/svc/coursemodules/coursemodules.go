package coursemodules

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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewCourseModulesSvc),
)

func init() {
	Package(internal.Injector)
}

type CourseModulesSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.CourseModuleServiceHandler = (*CourseModulesSvc)(nil)

func NewCourseModulesSvc(i do.Injector) (s *CourseModulesSvc, err error) {
	s = new(CourseModulesSvc)
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

func (s *CourseModulesSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewCourseModuleServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

func (s *CourseModulesSvc) fetchCourse(ctx context.Context, id string) (gen.Course, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.Course{}, err
	}
	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.GetCourseByID(ctx, uuid)
	})
	if err != nil {
		return gen.Course{}, svc.ConnectDBError(err)
	}
	return course, nil
}

func (s *CourseModulesSvc) fetchModule(ctx context.Context, id string) (gen.CourseModule, error) {
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

func (s *CourseModulesSvc) CreateCourseModule(
	ctx context.Context,
	req *richterv1.CreateCourseModuleRequest,
) (*richterv1.CreateCourseModuleResponse, error) {
	course, err := s.fetchCourse(ctx, req.GetCourseId())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("CreateCourseModule.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	m, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseModule, error) {
		return q.CreateCourseModule(ctx, gen.CreateCourseModuleParams{
			CourseID:   course.ID,
			Title:      req.GetTitle(),
			OrderIndex: req.GetOrderIndex(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("CreateCourseModule", err)...)
		return nil, err
	}
	return &richterv1.CreateCourseModuleResponse{Module: CourseModuleToProto(m)}, nil
}

func (s *CourseModulesSvc) GetCourseModuleById(
	ctx context.Context,
	req *richterv1.GetCourseModuleByIdRequest,
) (*richterv1.GetCourseModuleByIdResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	m, err := s.fetchModule(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("GetCourseModuleById", err)...)
		return nil, err
	}
	return &richterv1.GetCourseModuleByIdResponse{Module: CourseModuleToProto(m)}, nil
}

func (s *CourseModulesSvc) ListCourseModules(
	ctx context.Context,
	req *richterv1.ListCourseModulesRequest,
) (*richterv1.ListCourseModulesResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("ListCourseModules.ParseUUID", err)...)
		return nil, err
	}

	modules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
		return q.ListCourseModules(ctx, gen.ListCourseModulesParams{
			CourseID: courseID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("ListCourseModules", err)...)
		return nil, err
	}

	out := make([]*richterv1.CourseModule, 0, len(modules))
	for _, m := range modules {
		out = append(out, CourseModuleToProto(m))
	}
	return &richterv1.ListCourseModulesResponse{Modules: out}, nil
}

func (s *CourseModulesSvc) UpdateCourseModule(
	ctx context.Context,
	req *richterv1.UpdateCourseModuleRequest,
) (*richterv1.UpdateCourseModuleResponse, error) {
	existing, err := s.fetchModule(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("UpdateCourseModule.fetch", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, existing.CourseID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("UpdateCourseModule.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	m, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseModule, error) {
		return q.UpdateCourseModule(ctx, gen.UpdateCourseModuleParams{
			ID:         existing.ID,
			Title:      req.GetTitle(),
			OrderIndex: req.GetOrderIndex(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("UpdateCourseModule", err)...)
		return nil, err
	}
	return &richterv1.UpdateCourseModuleResponse{Module: CourseModuleToProto(m)}, nil
}

func (s *CourseModulesSvc) DeleteCourseModule(
	ctx context.Context,
	req *richterv1.DeleteCourseModuleRequest,
) (*richterv1.DeleteCourseModuleResponse, error) {
	existing, err := s.fetchModule(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("DeleteCourseModule.fetch", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, existing.CourseID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("DeleteCourseModule.fetchCourse", err)...)
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
		return q.DeleteCourseModule(ctx, existing.ID)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("DeleteCourseModule", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("course module not found: %s", existing.ID))
		s.log.ErrorContext(ctx, "course modules service failed", svc.LogAttrs("DeleteCourseModule.NotFound", err)...)
		return nil, err
	}
	return &richterv1.DeleteCourseModuleResponse{}, nil
}
