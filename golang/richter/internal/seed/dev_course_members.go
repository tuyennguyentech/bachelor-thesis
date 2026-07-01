package seed

import (
	"context"
	"fmt"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/coursemembers"
	"example.com/sql/gen"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var courseRoleProto = map[string]richterv1.CourseRole{
	"student": richterv1.CourseRole_COURSE_ROLE_STUDENT,
	"teacher": richterv1.CourseRole_COURSE_ROLE_TEACHER,
}

// seedDevCourseMembers enrols dev users in courses THROUGH the real
// CourseMembersSvc.AddCourseMember flow (synthesized org-owner auth), not a raw
// insert. The service itself enforces the "course member must be an ACTIVE org
// member" invariant — so the seed no longer needs a manual guard, and the data is
// consistent by construction.
func (s *SeederSvc) seedDevCourseMembers(ctx context.Context, members []devCourseMemberSpec) error {
	cmSvc, err := do.Invoke[*coursemembers.CourseMembersSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke CourseMembersSvc: %w", err)
	}
	for _, m := range members {
		role, ok := courseRoleProto[m.Role]
		if !ok {
			return fmt.Errorf("course member %s: unknown role %q", m.UserEmail, m.Role)
		}
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, m.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", m.OrgSlug, err)
		}
		courseID, found, err := s.courseIDByTitle(ctx, org.ID, m.CourseTitle)
		if err != nil {
			return fmt.Errorf("lookup course %q: %w", m.CourseTitle, err)
		}
		if !found {
			s.log.InfoContext(ctx, "seed: course member skipped — course not found", "course", m.CourseTitle)
			continue
		}
		user, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, m.UserEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup user %s: %w", m.UserEmail, err)
		}

		// Act as the org owner (a course manager): RequireCourseManager passes via
		// the org-owner check, so the synthesized JWT role can stay NORMAL.
		actx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
			Sub:    uuidStr(org.CreatedBy),
			Role:   richterv1.UserRole_USER_ROLE_NORMAL,
			Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		_, err = cmSvc.AddCourseMember(actx, &richterv1.AddCourseMemberRequest{
			CourseId: uuidStr(courseID),
			UserId:   uuidStr(user.ID),
			Role:     role,
		})
		if err == nil {
			s.log.InfoContext(ctx, "seed: dev course member created", "course", m.CourseTitle, "user", m.UserEmail, "role", m.Role)
			continue
		}
		switch connect.CodeOf(err) {
		case connect.CodeAlreadyExists:
			s.log.InfoContext(ctx, "seed: dev course member already exists, skipping", "course", m.CourseTitle, "user", m.UserEmail)
		case connect.CodeFailedPrecondition:
			// Service-enforced invariant: target must be an ACTIVE org member.
			// Skip (don't fail) — same outcome as the old manual guard.
			s.log.WarnContext(ctx, "seed: course member skipped — not an active org member",
				"course", m.CourseTitle, "user", m.UserEmail, "org", m.OrgSlug, "err", err)
		default:
			return fmt.Errorf("add course member %s to %s: %w", m.UserEmail, m.CourseTitle, err)
		}
	}
	return nil
}
