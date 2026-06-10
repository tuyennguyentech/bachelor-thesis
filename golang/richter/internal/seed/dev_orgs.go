package seed

import (
	"context"
	"fmt"

	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *SeederSvc) seedDevOrganizations(ctx context.Context, orgs []devOrgSpec) error {
	for _, o := range orgs {
		creator, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, o.CreatorEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup creator %s for org %s: %w", o.CreatorEmail, o.Slug, err)
		}

		_, err = db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.Organization, error) {
			org, err := q.CreateOrganization(ctx, gen.CreateOrganizationParams{
				CreatedBy: creator.ID,
				Name:      o.Name,
				Slug:      o.Slug,
			})
			if err != nil {
				return gen.Organization{}, err
			}
			_, err = q.AddOrganizationMember(ctx, gen.AddOrganizationMemberParams{
				OrganizationID: org.ID,
				UserID:         creator.ID,
				Role:           gen.OrganizationRoleOwner,
				Status:         gen.MemberStatusActive,
			})
			return org, err
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev org already exists, skipping", "slug", o.Slug)
			continue
		}
		if err != nil {
			return fmt.Errorf("create org %s: %w", o.Slug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org created", "slug", o.Slug)
	}
	return nil
}

func (s *SeederSvc) seedDevOrgMembers(ctx context.Context, members []devOrgMemberSpec) error {
	for _, m := range members {
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, m.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", m.OrgSlug, err)
		}

		user, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, m.UserEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup user %s: %w", m.UserEmail, err)
		}

		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
			return q.AddOrganizationMember(ctx, gen.AddOrganizationMemberParams{
				OrganizationID: org.ID,
				UserID:         user.ID,
				Role:           gen.OrganizationRole(m.Role),
				Status:         gen.MemberStatus(m.Status),
			})
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev org member already exists, skipping", "org", m.OrgSlug, "user", m.UserEmail)
			continue
		}
		if err != nil {
			return fmt.Errorf("create member %s in %s: %w", m.UserEmail, m.OrgSlug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org member created", "org", m.OrgSlug, "user", m.UserEmail)
	}
	return nil
}
