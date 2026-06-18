package coursemembers

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	jwtv1 "example.com/buf/gen/richter/jwt/v1"
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

	// A course member must also be an ACTIVE member of the course's organization.
	// Without this check a manager could enroll someone who isn't in the org (or
	// was suspended), producing a course_members row that grants course access to
	// a non-org-member — they could open the course yet be absent from the org.
	// Fetch the course's org and verify the target's active org membership first.
	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.GetCourseByID(ctx, courseID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, errors.New("course not found"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	orgMember, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: course.OrganizationID,
			UserID:         userID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("user is not a member of the course's organization"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if orgMember.Status != gen.MemberStatusActive {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("user's organization membership is not active"))
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

// EnrollSelf materialises the caller's OWN course_members row. It is permitted
// only for callers who already have BYPASS access to the course (system admin,
// course owner, or org owner/admin) — i.e. they can already reach the content,
// this just makes the membership explicit so they appear in the member list.
// Idempotent: if a row already exists it is returned unchanged. Plain course
// members and other org roles are denied (they must use the join-request flow).
func (s *CourseMembersSvc) EnrollSelf(
	ctx context.Context,
	req *richterv1.EnrollSelfRequest,
) (*richterv1.EnrollSelfResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}

	// Only bypass callers may self-enrol. requireCourseBypass returns NotFound
	// for a missing course and PermissionDenied for non-bypass callers.
	if err := s.requireCourseBypass(ctx, claims, courseID); err != nil {
		return nil, err
	}

	// Role to enrol as. Unspecified defaults to TEACHER (manager), since only
	// bypass callers reach here.
	role := gen.CourseRoleTeacher
	if req.GetRole() != richterv1.CourseRole_COURSE_ROLE_UNSPECIFIED {
		role, err = CourseRoleToSQL(req.GetRole())
		if err != nil {
			return nil, err
		}
	}

	// Idempotent + atomic: EnrollCourseMemberIfAbsent inserts a new row or, on
	// conflict, returns the EXISTING row unchanged (no role mutation). Doing the
	// check + insert in one statement closes the TOCTOU window a separate
	// GetCourseMember pre-check would leave — concurrent self-enrols can never
	// silently promote/demote.
	member, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseMember, error) {
		return q.EnrollCourseMemberIfAbsent(ctx, gen.EnrollCourseMemberIfAbsentParams{
			CourseID: courseID,
			UserID:   userID,
			Role:     role,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "course_members service failed", svc.LogAttrs("EnrollSelf", err)...)
		return nil, err
	}
	return &richterv1.EnrollSelfResponse{Member: CourseMemberToProto(member)}, nil
}

// GetMyCourseMembership returns the caller's OWN course_members row (presence +
// role). Any authenticated user may call it — it only ever exposes the caller's
// own membership (keyed on the token subject) — so the UI can decide canManage
// by membership without listing all members.
func (s *CourseMembersSvc) GetMyCourseMembership(
	ctx context.Context,
	req *richterv1.GetMyCourseMembershipRequest,
) (*richterv1.GetMyCourseMembershipResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}

	member, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseMember, error) {
		return q.GetCourseMember(ctx, gen.GetCourseMemberParams{CourseID: courseID, UserID: userID})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &richterv1.GetMyCourseMembershipResponse{
				IsMember: false,
				Role:     richterv1.CourseRole_COURSE_ROLE_UNSPECIFIED,
			}, nil
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	return &richterv1.GetMyCourseMembershipResponse{
		IsMember: true,
		Role:     CourseRoleToProto(member.Role),
	}, nil
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

	// Already-enrolled users don't need to request to join.
	isMember, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (bool, error) {
		return q.IsCourseMember(ctx, gen.IsCourseMemberParams{CourseID: courseID, UserID: userID})
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if isMember {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("already a member of this course"))
	}

	// Requested role. Unspecified defaults to STUDENT (request to learn) so the
	// existing student flow keeps working. An org member may request TEACHER
	// (request to manage); the requested role is honoured only on approval by a
	// course manager.
	requestedRole := gen.CourseRoleStudent
	if req.GetRequestedRole() != richterv1.CourseRole_COURSE_ROLE_UNSPECIFIED {
		requestedRole, err = CourseRoleToSQL(req.GetRequestedRole())
		if err != nil {
			return nil, err
		}
	}

	// Create or update the join request in database
	request, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseJoinRequest, error) {
		return q.CreateJoinRequest(ctx, gen.CreateJoinRequestParams{
			CourseID:      courseID,
			UserID:        userID,
			RequestedRole: requestedRole,
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

	// Re-verify org membership at APPROVAL time (not just at request time): the
	// requester may have left or been suspended from the org between requesting
	// and approval, so approving would otherwise (re)create a course_members row
	// for a non-org-member — the same BUG-E invariant AddCourseMember enforces.
	if req.GetApprove() {
		course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
			return q.GetCourseByID(ctx, courseID)
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, connect.NewError(connect.CodeNotFound, errors.New("course not found"))
			}
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		orgMember, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
			return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
				OrganizationID: course.OrganizationID,
				UserID:         userID,
			})
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("requester is no longer a member of the organization"))
			}
			return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
		}
		if orgMember.Status != gen.MemberStatusActive {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("requester's organization membership is not active"))
		}
	}

	var status gen.JoinRequestStatus
	if req.GetApprove() {
		status = gen.JoinRequestStatusApproved
	} else {
		status = gen.JoinRequestStatusRejected
	}

	err = db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, tx pgx.Tx) error {
		// Update status. The returned row carries the requested role, so the
		// course_members row is created with the role the requester asked for
		// (STUDENT = learner / TEACHER = manager).
		reviewed, err := q.ReviewJoinRequest(ctx, gen.ReviewJoinRequestParams{
			CourseID: courseID,
			UserID:   userID,
			Status:   status,
		})
		if err != nil {
			return err
		}

		if req.GetApprove() {
			// Add to course_members with the requested role.
			_, err = q.AddCourseMember(ctx, gen.AddCourseMemberParams{
				CourseID: courseID,
				UserID:   userID,
				Role:     reviewed.RequestedRole,
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

// requireCourseBypass returns nil if the caller has BYPASS access to the course
// (system admin, course owner, or org owner/admin) — the same set that passes
// RequireCourseMember without an explicit course_members row. Unlike
// requireCourseManager it deliberately does NOT honour a course-TEACHER row:
// EnrollSelf is for callers who don't yet have a membership row, so a plain
// course member must not use it to mutate their own role. Returns NotFound for
// a missing course and PermissionDenied otherwise.
func (s *CourseMembersSvc) requireCourseBypass(ctx context.Context, claims *jwtv1.JWTClaims, courseID pgtype.UUID) error {
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
	return connect.NewError(connect.CodePermissionDenied, errors.New("not allowed to self-enrol in this course"))
}
