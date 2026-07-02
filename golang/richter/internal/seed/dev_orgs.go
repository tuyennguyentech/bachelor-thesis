package seed

import (
	"context"
	"errors"
	"fmt"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/organizations"
	"example.com/richter/internal/svc/orgmembers"
	"example.com/sql/gen"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var orgRoleProto = map[string]richterv1.OrganizationRole{
	"owner":   richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER,
	"admin":   richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN,
	"teacher": richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER,
	"student": richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
}

var memberStatusProto = map[string]richterv1.MemberStatus{
	"active":    richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	"invited":   richterv1.MemberStatus_MEMBER_STATUS_INVITED,
	"suspended": richterv1.MemberStatus_MEMBER_STATUS_SUSPENDED,
}

// seedDevOrganizations creates orgs THROUGH OrganizationsSvc.CreateOrganization
// (synthesized creator auth — the service requires Sub == created_by). The service
// auto-adds the creator as the OWNER member in the same transaction, so no manual
// owner insert is needed.
func (s *SeederSvc) seedDevOrganizations(ctx context.Context, orgs []devOrgSpec) error {
	orgSvc, err := do.Invoke[*organizations.OrganizationsSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke OrganizationsSvc: %w", err)
	}
	for _, o := range orgs {
		// Declarative desired-state: probe by unique slug. If present, CONVERGE the
		// mutable metadata (name) to the spec; if absent, INSERT. A real lookup failure
		// (not "no rows") is a genuine error → STOP.
		existingOrg, lookupErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, o.Slug)
		})
		if lookupErr == nil {
			if existingOrg.Name != o.Name {
				// Update through the service AS THE ORG OWNER (the creator, an auto-added
				// OWNER member) — UpdateOrganization requires org OWNER/ADMIN.
				ownerCtx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
					Sub:    uuidStr(existingOrg.CreatedBy),
					Role:   richterv1.UserRole_USER_ROLE_NORMAL,
					Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
				})
				if _, err := orgSvc.UpdateOrganization(ownerCtx, &richterv1.UpdateOrganizationRequest{
					Id: uuidStr(existingOrg.ID), Name: o.Name, Slug: o.Slug,
				}); err != nil {
					return fmt.Errorf("converge org %s name: %w", o.Slug, err)
				}
				s.log.InfoContext(ctx, "seed: dev org name converged", "slug", o.Slug)
			}
			continue
		}
		if !errors.Is(lookupErr, pgx.ErrNoRows) {
			return fmt.Errorf("lookup org %s: %w", o.Slug, lookupErr)
		}
		creator, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, o.CreatorEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup creator %s for org %s: %w", o.CreatorEmail, o.Slug, err)
		}
		actx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
			Sub:    uuidStr(creator.ID),
			Role:   richterv1.UserRole_USER_ROLE_NORMAL,
			Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if _, err := orgSvc.CreateOrganization(actx, &richterv1.CreateOrganizationRequest{
			CreatedBy: uuidStr(creator.ID),
			Name:      o.Name,
			Slug:      o.Slug,
		}); err != nil {
			return fmt.Errorf("create org %s: %w", o.Slug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org created", "slug", o.Slug)
	}
	return nil
}

// seedDevOrgMembers adds org members THROUGH OrgMembersSvc.AddOrganizationMember
// (synthesized org-owner auth — the creator is the auto-added OWNER). Role + status
// (incl. invited/suspended) are set by the service.
func (s *SeederSvc) seedDevOrgMembers(ctx context.Context, members []devOrgMemberSpec) error {
	omSvc, err := do.Invoke[*orgmembers.OrgMembersSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke OrgMembersSvc: %w", err)
	}
	for _, m := range members {
		role, ok := orgRoleProto[m.Role]
		if !ok {
			return fmt.Errorf("org member %s: unknown role %q", m.UserEmail, m.Role)
		}
		status, ok := memberStatusProto[m.Status]
		if !ok {
			return fmt.Errorf("org member %s: unknown status %q", m.UserEmail, m.Status)
		}
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
		// Act as the org owner (the creator) — Add/Update member both require OWNER/ADMIN.
		actx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
			Sub:    uuidStr(org.CreatedBy),
			Role:   richterv1.UserRole_USER_ROLE_NORMAL,
			Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		// Declarative desired-state: probe the (org,user) membership. If present,
		// CONVERGE role + status to the spec (update only what drifts); if absent, ADD.
		existingMember, lookupErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
			return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{OrganizationID: org.ID, UserID: user.ID})
		})
		if lookupErr == nil {
			if orgmembers.OrganizationRoleToProto(existingMember.Role) != role {
				if _, err := omSvc.UpdateOrganizationMemberRole(actx, &richterv1.UpdateOrganizationMemberRoleRequest{
					OrganizationId: uuidStr(org.ID), UserId: uuidStr(user.ID), Role: role,
				}); err != nil {
					return fmt.Errorf("converge org member role %s in %s: %w", m.UserEmail, m.OrgSlug, err)
				}
				s.log.InfoContext(ctx, "seed: dev org member role converged", "org", m.OrgSlug, "user", m.UserEmail, "role", m.Role)
			}
			if orgmembers.MemberStatusToProto(existingMember.Status) != status {
				if _, err := omSvc.UpdateOrganizationMemberStatus(actx, &richterv1.UpdateOrganizationMemberStatusRequest{
					OrganizationId: uuidStr(org.ID), UserId: uuidStr(user.ID), Status: status,
				}); err != nil {
					return fmt.Errorf("converge org member status %s in %s: %w", m.UserEmail, m.OrgSlug, err)
				}
				s.log.InfoContext(ctx, "seed: dev org member status converged", "org", m.OrgSlug, "user", m.UserEmail, "status", m.Status)
			}
			continue
		}
		if !errors.Is(lookupErr, pgx.ErrNoRows) {
			return fmt.Errorf("lookup org member %s in %s: %w", m.UserEmail, m.OrgSlug, lookupErr)
		}
		if _, err := omSvc.AddOrganizationMember(actx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: uuidStr(org.ID),
			UserId:         uuidStr(user.ID),
			Role:           role,
			Status:         status,
		}); err != nil {
			return fmt.Errorf("add org member %s to %s: %w", m.UserEmail, m.OrgSlug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org member created", "org", m.OrgSlug, "user", m.UserEmail)
	}
	return nil
}
