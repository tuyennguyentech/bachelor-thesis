package seed

import (
	"context"
	"errors"
	"fmt"

	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedDevCourseMembers seeds course membership records for dev users.
// It mirrors seedDevOrgMembers: looks up the course by org slug + title, then
// the user by email, and calls AddCourseMember (which is itself idempotent —
// ON CONFLICT DO UPDATE — so repeated runs are safe).
func (s *SeederSvc) seedDevCourseMembers(ctx context.Context, members []devCourseMemberSpec) error {
	for _, m := range members {
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, m.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", m.OrgSlug, err)
		}

		// Find course by title within the org.
		courses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: org.ID, Limit: 200, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list courses for org %s: %w", m.OrgSlug, err)
		}
		var courseID pgtype.UUID
		for _, c := range courses {
			if c.Title == m.CourseTitle {
				courseID = c.ID
				break
			}
		}
		if !courseID.Valid {
			s.log.InfoContext(ctx, "seed: course member skipped — course not found", "course", m.CourseTitle)
			continue
		}

		user, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, m.UserEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup user %s: %w", m.UserEmail, err)
		}

		// Invariant guard: a course member MUST be an active org member. The
		// production AddCourseMember RPC enforces this; the raw SQL below bypasses
		// it, so guard here — skip (don't insert) any non-active member so the seed
		// never creates a state production would reject.
		om, omErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
			return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{OrganizationID: org.ID, UserID: user.ID})
		})
		if omErr != nil {
			if errors.Is(omErr, pgx.ErrNoRows) {
				s.log.WarnContext(ctx, "seed: course member skipped — not an org member",
					"course", m.CourseTitle, "user", m.UserEmail, "org", m.OrgSlug)
				continue
			}
			return fmt.Errorf("check org membership for %s in %s: %w", m.UserEmail, m.OrgSlug, omErr)
		}
		if om.Status != gen.MemberStatusActive {
			s.log.WarnContext(ctx, "seed: course member skipped — org membership not active",
				"course", m.CourseTitle, "user", m.UserEmail, "org", m.OrgSlug, "status", om.Status)
			continue
		}

		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseMember, error) {
			return q.AddCourseMember(ctx, gen.AddCourseMemberParams{
				CourseID: courseID,
				UserID:   user.ID,
				Role:     gen.CourseRole(m.Role),
			})
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev course member already exists, skipping", "course", m.CourseTitle, "user", m.UserEmail)
			continue
		}
		if err != nil {
			return fmt.Errorf("add course member %s to %s: %w", m.UserEmail, m.CourseTitle, err)
		}
		s.log.InfoContext(ctx, "seed: dev course member created", "course", m.CourseTitle, "user", m.UserEmail, "role", m.Role)
	}
	return nil
}
