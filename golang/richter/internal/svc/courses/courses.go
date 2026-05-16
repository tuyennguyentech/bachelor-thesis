package courses

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
	do.Lazy(NewCoursesSvc),
)

func init() {
	Package(internal.Injector)
}

type CoursesSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.CourseServiceHandler = (*CoursesSvc)(nil)

func NewCoursesSvc(i do.Injector) (s *CoursesSvc, err error) {
	s = new(CoursesSvc)
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

func (s *CoursesSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewCourseServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

func (s *CoursesSvc) fetchCourse(ctx context.Context, id string) (gen.Course, error) {
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

func (s *CoursesSvc) CreateCourse(
	ctx context.Context,
	req *richterv1.CreateCourseRequest,
) (*richterv1.CreateCourseResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("CreateCourse.ParseUUID(org)", err)...)
		return nil, err
	}
	claims, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	)
	if err != nil {
		return nil, err
	}
	ownerID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("CreateCourse.ParseUUID(owner)", err)...)
		return nil, err
	}

	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.CreateCourse(ctx, gen.CreateCourseParams{
			OrganizationID: orgID,
			OwnerID:        ownerID,
			Title:          req.GetTitle(),
			Description:    descriptionToPgText(req.GetDescription()),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("CreateCourse", err)...)
		return nil, err
	}
	return &richterv1.CreateCourseResponse{Course: CourseToProto(course)}, nil
}

func (s *CoursesSvc) GetCourseById(
	ctx context.Context,
	req *richterv1.GetCourseByIdRequest,
) (*richterv1.GetCourseByIdResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	course, err := s.fetchCourse(ctx, req.GetId())
	if err != nil {
		if connect.CodeOf(err) == connect.CodeNotFound && claims.GetRole() != richterv1.UserRole_USER_ROLE_ADMIN {
			return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("not a member of this organization"))
		}
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("GetCourseById", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgMember(ctx, course.OrganizationID); err != nil {
		return nil, err
	}
	return &richterv1.GetCourseByIdResponse{Course: CourseToProto(course)}, nil
}

func (s *CoursesSvc) ListCourses(
	ctx context.Context,
	req *richterv1.ListCoursesRequest,
) (*richterv1.ListCoursesResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("ListCourses.ParseUUID", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	var courses []gen.Course
	if req.Q != nil && *req.Q != "" {
		courses, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrgAndTitleFilter(ctx, gen.ListCoursesByOrgAndTitleFilterParams{
				OrganizationID: orgID,
				Column2:        req.GetQ(),
				Limit:          req.GetLimit(),
				Offset:         req.GetOffset(),
			})
		})
	} else if req.StatusFilter != nil {
		sqlStatus, err := CourseStatusToSQL(req.GetStatusFilter())
		if err != nil {
			s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("ListCourses.StatusToSQL", err)...)
			return nil, err
		}
		courses, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrgAndStatus(ctx, gen.ListCoursesByOrgAndStatusParams{
				OrganizationID: orgID,
				Status:         sqlStatus,
				Limit:          req.GetLimit(),
				Offset:         req.GetOffset(),
			})
		})
	} else {
		courses, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{
				OrganizationID: orgID,
				Limit:          req.GetLimit(),
				Offset:         req.GetOffset(),
			})
		})
	}
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("ListCourses", err)...)
		return nil, err
	}

	out := make([]*richterv1.Course, 0, len(courses))
	for _, c := range courses {
		out = append(out, CourseToProto(c))
	}
	return &richterv1.ListCoursesResponse{Courses: out}, nil
}

func (s *CoursesSvc) UpdateCourse(
	ctx context.Context,
	req *richterv1.UpdateCourseRequest,
) (*richterv1.UpdateCourseResponse, error) {
	existing, err := s.fetchCourse(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("UpdateCourse.fetch", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, existing.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.UpdateCourse(ctx, gen.UpdateCourseParams{
			ID:          existing.ID,
			Title:       req.GetTitle(),
			Description: descriptionToPgText(req.GetDescription()),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("UpdateCourse", err)...)
		return nil, err
	}
	return &richterv1.UpdateCourseResponse{Course: CourseToProto(course)}, nil
}

func (s *CoursesSvc) UpdateCourseStatus(
	ctx context.Context,
	req *richterv1.UpdateCourseStatusRequest,
) (*richterv1.UpdateCourseStatusResponse, error) {
	existing, err := s.fetchCourse(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("UpdateCourseStatus.fetch", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, existing.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
	); err != nil {
		return nil, err
	}
	status, err := CourseStatusToSQL(req.GetStatus())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("UpdateCourseStatus.StatusToSQL", err)...)
		return nil, err
	}

	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.UpdateCourseStatus(ctx, gen.UpdateCourseStatusParams{
			ID:     existing.ID,
			Status: status,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("UpdateCourseStatus", err)...)
		return nil, err
	}
	return &richterv1.UpdateCourseStatusResponse{Course: CourseToProto(course)}, nil
}

func (s *CoursesSvc) DeleteCourse(
	ctx context.Context,
	req *richterv1.DeleteCourseRequest,
) (*richterv1.DeleteCourseResponse, error) {
	existing, err := s.fetchCourse(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("DeleteCourse.fetch", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, existing.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
	); err != nil {
		return nil, err
	}

	rowsAffected, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.DeleteCourse(ctx, existing.ID)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("DeleteCourse", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("course not found: %s", existing.ID))
		s.log.ErrorContext(ctx, "courses service failed", svc.LogAttrs("DeleteCourse.NotFound", err)...)
		return nil, err
	}
	return &richterv1.DeleteCourseResponse{}, nil
}
