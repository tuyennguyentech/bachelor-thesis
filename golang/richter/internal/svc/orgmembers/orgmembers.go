package orgmembers

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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewOrgMembersSvc),
)

func init() {
	Package(internal.Injector)
}

type OrgMembersSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.OrganizationMemberServiceHandler = (*OrgMembersSvc)(nil)

func NewOrgMembersSvc(i do.Injector) (o *OrgMembersSvc, err error) {
	o = new(OrgMembersSvc)
	o.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	o.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	o.authz, err = do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	return
}

func (o *OrgMembersSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewOrganizationMemberServiceHandler(
		o,
		connect.WithInterceptors(validate.NewInterceptor(), o.authz.Interceptor()),
	)
}

func (o *OrgMembersSvc) AddOrganizationMember(
	ctx context.Context,
	req *richterv1.AddOrganizationMemberRequest,
) (*richterv1.AddOrganizationMemberResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("AddOrganizationMember.ParseOrgUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("AddOrganizationMember.ParseUserUUID", err)...)
		return nil, err
	}
	role, err := OrganizationRoleToSQL(req.GetRole())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("AddOrganizationMember.OrganizationRoleToSQL", err)...)
		return nil, err
	}
	status, err := MemberStatusToSQL(req.GetStatus())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("AddOrganizationMember.MemberStatusToSQL", err)...)
		return nil, err
	}

	member, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.AddOrganizationMember(ctx, gen.AddOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
			Role:           role,
			Status:         status,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("AddOrganizationMember", err)...)
		return nil, err
	}
	return &richterv1.AddOrganizationMemberResponse{Member: OrganizationMemberToProto(member)}, nil
}

func (o *OrgMembersSvc) GetOrganizationMember(
	ctx context.Context,
	req *richterv1.GetOrganizationMemberRequest,
) (*richterv1.GetOrganizationMemberResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("GetOrganizationMember.ParseOrgUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("GetOrganizationMember.ParseUserUUID", err)...)
		return nil, err
	}

	member, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("GetOrganizationMember", err)...)
		return nil, err
	}
	return &richterv1.GetOrganizationMemberResponse{Member: OrganizationMemberToProto(member)}, nil
}

func (o *OrgMembersSvc) ListOrganizationMembers(
	ctx context.Context,
	req *richterv1.ListOrganizationMembersRequest,
) (*richterv1.ListOrganizationMembersResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("ListOrganizationMembers.ParseUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	members, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.OrganizationMember, error) {
		return q.ListOrganizationMembers(ctx, gen.ListOrganizationMembersParams{
			OrganizationID: orgID,
			Limit:          req.GetLimit(),
			Offset:         req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("ListOrganizationMembers", err)...)
		return nil, err
	}

	out := make([]*richterv1.OrganizationMember, 0, len(members))
	for _, m := range members {
		out = append(out, OrganizationMemberToProto(m))
	}
	return &richterv1.ListOrganizationMembersResponse{Members: out}, nil
}

func (o *OrgMembersSvc) ListUserMemberships(
	ctx context.Context,
	req *richterv1.ListUserMembershipsRequest,
) (*richterv1.ListUserMembershipsResponse, error) {
	if _, err := o.authz.RequireSelf(ctx, req.GetUserId()); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("ListUserMemberships.ParseUUID", err)...)
		return nil, err
	}

	members, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.OrganizationMember, error) {
		return q.ListUserMemberships(ctx, gen.ListUserMembershipsParams{
			UserID: userID,
			Limit:  req.GetLimit(),
			Offset: req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("ListUserMemberships", err)...)
		return nil, err
	}

	out := make([]*richterv1.OrganizationMember, 0, len(members))
	for _, m := range members {
		out = append(out, OrganizationMemberToProto(m))
	}
	return &richterv1.ListUserMembershipsResponse{Members: out}, nil
}

func (o *OrgMembersSvc) UpdateOrganizationMemberRole(
	ctx context.Context,
	req *richterv1.UpdateOrganizationMemberRoleRequest,
) (*richterv1.UpdateOrganizationMemberRoleResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberRole.ParseOrgUUID", err)...)
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberRole.ParseUserUUID", err)...)
		return nil, err
	}
	role, err := OrganizationRoleToSQL(req.GetRole())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberRole.OrganizationRoleToSQL", err)...)
		return nil, err
	}

	// Fetch target's current role to determine required caller permission level.
	// Only ORG_OWNER or SYS_ADMIN may change an OWNER's role.
	targetMember, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberRole.GetTargetMember", err)...)
		return nil, err
	}
	if targetMember.Role == gen.OrganizationRoleOwner {
		if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleOwner); err != nil {
			return nil, err
		}
	} else {
		if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
			return nil, err
		}
	}

	member, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.UpdateOrganizationMemberRole(ctx, gen.UpdateOrganizationMemberRoleParams{
			OrganizationID: orgID,
			UserID:         userID,
			Role:           role,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberRole", err)...)
		return nil, err
	}
	return &richterv1.UpdateOrganizationMemberRoleResponse{Member: OrganizationMemberToProto(member)}, nil
}

func (o *OrgMembersSvc) UpdateOrganizationMemberStatus(
	ctx context.Context,
	req *richterv1.UpdateOrganizationMemberStatusRequest,
) (*richterv1.UpdateOrganizationMemberStatusResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberStatus.ParseOrgUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberStatus.ParseUserUUID", err)...)
		return nil, err
	}
	status, err := MemberStatusToSQL(req.GetStatus())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberStatus.MemberStatusToSQL", err)...)
		return nil, err
	}

	member, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.UpdateOrganizationMemberStatus(ctx, gen.UpdateOrganizationMemberStatusParams{
			OrganizationID: orgID,
			UserID:         userID,
			Status:         status,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("UpdateOrganizationMemberStatus", err)...)
		return nil, err
	}
	return &richterv1.UpdateOrganizationMemberStatusResponse{Member: OrganizationMemberToProto(member)}, nil
}

func (o *OrgMembersSvc) RemoveOrganizationMember(
	ctx context.Context,
	req *richterv1.RemoveOrganizationMemberRequest,
) (*richterv1.RemoveOrganizationMemberResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("RemoveOrganizationMember.ParseOrgUUID", err)...)
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("RemoveOrganizationMember.ParseUserUUID", err)...)
		return nil, err
	}

	callerClaims, err := o.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}

	if callerClaims.GetRole() != richterv1.UserRole_USER_ROLE_ADMIN {
		callerID, err := svc.ParseUUID(callerClaims.GetSub())
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
		}
		callerMember, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
			return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
				OrganizationID: orgID,
				UserID:         callerID,
			})
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this organization"))
			}
			return nil, connect.NewError(connect.CodeInternal, err)
		}

		switch callerMember.Role {
		case gen.OrganizationRoleStudent, gen.OrganizationRoleTeacher:
			if callerClaims.GetSub() != req.GetUserId() {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
			}
		case gen.OrganizationRoleAdmin:
			targetMember, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
				return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
					OrganizationID: orgID,
					UserID:         userID,
				})
			})
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
			}
			if err == nil && targetMember.Role == gen.OrganizationRoleOwner {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("org admin cannot remove owner"))
			}
		case gen.OrganizationRoleOwner:
			// owner can remove anyone
		}
	}

	rowsAffected, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.RemoveOrganizationMember(ctx, gen.RemoveOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("RemoveOrganizationMember", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("member not found: org=%s user=%s", orgID.String(), userID.String()))
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("RemoveOrganizationMember.NotFound", err)...)
		return nil, err
	}
	return &richterv1.RemoveOrganizationMemberResponse{}, nil
}
