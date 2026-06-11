package coursemembers

import (
	"context"
	"errors"
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewCourseMembersSvc),
)

func init() {
	Package(internal.Injector)
}

type CourseMembersSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.CourseMemberServiceHandler = (*CourseMembersSvc)(nil)

func NewCourseMembersSvc(i do.Injector) (s *CourseMembersSvc, err error) {
	s = new(CourseMembersSvc)
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

func (s *CourseMembersSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewCourseMemberServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

// AddCourseMember adds a user to a course. Requires course owner, org owner/admin, or
// a course teacher.
func (s *CourseMembersSvc) AddCourseMember(
	ctx context.Context,
	req *richterv1.AddCourseMemberRequest,
) (*richterv1.AddCourseMemberResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	if err := s.requireCourseManager(ctx, courseID); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}
	role, err := CourseRoleToSQL(req.GetRole())
	if err != nil {
		return nil, err
	}

	member, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseMember, error) {
		return q.AddCourseMember(ctx, gen.AddCourseMemberParams{
			CourseID: courseID,
			UserID:   userID,
			Role:     role,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("AddCourseMember", err)...)
		return nil, err
	}
	return &richterv1.AddCourseMemberResponse{Member: CourseMemberToProto(member)}, nil
}

// RemoveCourseMember removes a user from a course. Requires course manager rights.
func (s *CourseMembersSvc) RemoveCourseMember(
	ctx context.Context,
	req *richterv1.RemoveCourseMemberRequest,
) (*richterv1.RemoveCourseMemberResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	if err := s.requireCourseManager(ctx, courseID); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}

	rowsAffected, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.RemoveCourseMember(ctx, gen.RemoveCourseMemberParams{
			CourseID: courseID,
			UserID:   userID,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("RemoveCourseMember", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("member not found: course=%s user=%s", courseID.String(), userID.String()))
	}
	return &richterv1.RemoveCourseMemberResponse{}, nil
}

// ListCourseMembers returns members of a course. Requires course membership.
func (s *CourseMembersSvc) ListCourseMembers(
	ctx context.Context,
	req *richterv1.ListCourseMembersRequest,
) (*richterv1.ListCourseMembersResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	if _, err := s.authz.RequireCourseMember(ctx, courseID); err != nil {
		return nil, err
	}

	members, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListCourseMembersRow, error) {
		return q.ListCourseMembers(ctx, gen.ListCourseMembersParams{
			CourseID: courseID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("ListCourseMembers", err)...)
		return nil, err
	}

	out := make([]*richterv1.CourseMember, 0, len(members))
	for _, m := range members {
		out = append(out, CourseMemberRowToProto(m))
	}
	return &richterv1.ListCourseMembersResponse{Members: out}, nil
}

// ListUserCourses returns course memberships for a user. Self-scoped.
func (s *CourseMembersSvc) ListUserCourses(
	ctx context.Context,
	req *richterv1.ListUserCoursesRequest,
) (*richterv1.ListUserCoursesResponse, error) {
	if _, err := s.authz.RequireSelf(ctx, req.GetUserId()); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}

	memberships, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseMember, error) {
		return q.ListUserCourseMemberships(ctx, gen.ListUserCourseMembershipsParams{
			UserID: userID,
			Limit:  req.GetLimit(),
			Offset: req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("ListUserCourses", err)...)
		return nil, err
	}

	out := make([]*richterv1.CourseMember, 0, len(memberships))
	for _, m := range memberships {
		out = append(out, CourseMemberToProto(m))
	}
	return &richterv1.ListUserCoursesResponse{Memberships: out}, nil
}

func (s *CourseMembersSvc) CreateJoinRequest(
	ctx context.Context,
	req *richterv1.CreateJoinRequestRequest,
) (*richterv1.CreateJoinRequestResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	// Fetch the course to find its organization
	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.GetCourseByID(ctx, courseID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("course not found"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}

	// Verify that the caller belongs to the organization
	claims, err := s.authz.RequireOrgMember(ctx, course.OrganizationID)
	if err != nil {
		return nil, err
	}

	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}

	// Create or update the join request in database
	request, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseJoinRequest, error) {
		return q.CreateJoinRequest(ctx, gen.CreateJoinRequestParams{
			CourseID: courseID,
			UserID:   userID,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("CreateJoinRequest", err)...)
		return nil, err
	}

	return &richterv1.CreateJoinRequestResponse{
		Request: JoinRequestToProto(request),
	}, nil
}

func (s *CourseMembersSvc) ReviewJoinRequest(
	ctx context.Context,
	req *richterv1.ReviewJoinRequestRequest,
) (*richterv1.ReviewJoinRequestResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	if err := s.requireCourseManager(ctx, courseID); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}

	var status gen.JoinRequestStatus
	if req.GetApprove() {
		status = gen.JoinRequestStatusApproved
	} else {
		status = gen.JoinRequestStatusRejected
	}

	err = db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, tx pgx.Tx) error {
		// Update status
		_, err := q.ReviewJoinRequest(ctx, gen.ReviewJoinRequestParams{
			CourseID: courseID,
			UserID:   userID,
			Status:   status,
		})
		if err != nil {
			return err
		}

		if req.GetApprove() {
			// Add to course_members
			_, err = q.AddCourseMember(ctx, gen.AddCourseMemberParams{
				CourseID: courseID,
				UserID:   userID,
				Role:     gen.CourseRoleStudent,
			})
			if err != nil {
				return err
			}
		}
		return nil
	})

	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("ReviewJoinRequest", err)...)
		return nil, err
	}

	return &richterv1.ReviewJoinRequestResponse{}, nil
}

func (s *CourseMembersSvc) ListPendingJoinRequests(
	ctx context.Context,
	req *richterv1.ListPendingJoinRequestsRequest,
) (*richterv1.ListPendingJoinRequestsResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	if err := s.requireCourseManager(ctx, courseID); err != nil {
		return nil, err
	}

	requests, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListPendingJoinRequestsRow, error) {
		return q.ListPendingJoinRequests(ctx, gen.ListPendingJoinRequestsParams{
			CourseID: courseID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("ListPendingJoinRequests", err)...)
		return nil, err
	}

	out := make([]*richterv1.CourseJoinRequest, 0, len(requests))
	for _, r := range requests {
		out = append(out, JoinRequestRowToProto(r))
	}

	return &richterv1.ListPendingJoinRequestsResponse{
		Requests: out,
	}, nil
}

func (s *CourseMembersSvc) GetMyJoinRequestStatus(
	ctx context.Context,
	req *richterv1.GetMyJoinRequestStatusRequest,
) (*richterv1.GetMyJoinRequestStatusResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}

	request, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseJoinRequest, error) {
		return q.GetJoinRequest(ctx, gen.GetJoinRequestParams{
			CourseID: courseID,
			UserID:   userID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &richterv1.GetMyJoinRequestStatusResponse{Request: nil}, nil
		}
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("GetMyJoinRequestStatus", err)...)
		return nil, err
	}

	return &richterv1.GetMyJoinRequestStatusResponse{
		Request: JoinRequestToProto(request),
	}, nil
}

// requireCourseManager checks if the caller may manage course members:
// sys admin, course owner, org owner/admin, or a course teacher.
func (s *CourseMembersSvc) requireCourseManager(ctx context.Context, courseID pgtype.UUID) error {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return err
	}
	if claims.GetRole() == richterv1.UserRole_USER_ROLE_ADMIN {
		return nil
	}
	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}

	info, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.GetCourseAccessInfoByCourseIDRow, error) {
		return q.GetCourseAccessInfoByCourseID(ctx, courseID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return connect.NewError(connect.CodeNotFound, errors.New("course not found"))
		}
		return connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	// Course owner.
	if info.OwnerID == userID {
		return nil
	}
	// Org owner or admin.
	orgMember, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: info.OrganizationID,
			UserID:         userID,
		})
	})
	if err == nil && orgMember.Status == gen.MemberStatusActive {
		if orgMember.Role == gen.OrganizationRoleOwner || orgMember.Role == gen.OrganizationRoleAdmin {
			return nil
		}
	}
	// Course teacher.
	courseMember, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseMember, error) {
		return q.GetCourseMember(ctx, gen.GetCourseMemberParams{
			CourseID: courseID,
			UserID:   userID,
		})
	})
	if err == nil && courseMember.Role == gen.CourseRoleTeacher {
		return nil
	}
	return connect.NewError(connect.CodePermissionDenied, errors.New("insufficient permissions to manage course members"))
}
