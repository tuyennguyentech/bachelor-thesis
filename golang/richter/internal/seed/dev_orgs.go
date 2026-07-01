package seed

import (
	"context"
	"fmt"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/organizations"
	"example.com/richter/internal/svc/orgmembers"
	"example.com/sql/gen"

	"connectrpc.com/connect"
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
		_, err = orgSvc.CreateOrganization(actx, &richterv1.CreateOrganizationRequest{
			CreatedBy: uuidStr(creator.ID),
			Name:      o.Name,
			Slug:      o.Slug,
		})
		if err == nil {
			s.log.InfoContext(ctx, "seed: dev org created", "slug", o.Slug)
			continue
		}
		if connect.CodeOf(err) == connect.CodeAlreadyExists {
			s.log.InfoContext(ctx, "seed: dev org already exists, skipping", "slug", o.Slug)
			continue
		}
		return fmt.Errorf("create org %s: %w", o.Slug, err)
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
		actx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
			Sub:    uuidStr(org.CreatedBy),
			Role:   richterv1.UserRole_USER_ROLE_NORMAL,
			Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		_, err = omSvc.AddOrganizationMember(actx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: uuidStr(org.ID),
			UserId:         uuidStr(user.ID),
			Role:           role,
			Status:         status,
		})
		if err == nil {
			s.log.InfoContext(ctx, "seed: dev org member created", "org", m.OrgSlug, "user", m.UserEmail)
			continue
		}
		if connect.CodeOf(err) == connect.CodeAlreadyExists {
			s.log.InfoContext(ctx, "seed: dev org member already exists, skipping", "org", m.OrgSlug, "user", m.UserEmail)
			continue
		}
		return fmt.Errorf("add org member %s to %s: %w", m.UserEmail, m.OrgSlug, err)
	}
	return nil
}
