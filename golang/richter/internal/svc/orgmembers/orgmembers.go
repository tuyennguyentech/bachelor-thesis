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
		return nil, err
	}
	if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}
	role, err := OrganizationRoleToSQL(req.GetRole())
	if err != nil {
		return nil, err
	}
	// Only owner (or SYS_ADMIN) may add a new owner.
	if role == gen.OrganizationRoleOwner {
		if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleOwner); err != nil {
			return nil, err
		}
	}
	status, err := MemberStatusToSQL(req.GetStatus())
	if err != nil {
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
		return nil, err
	}
	// A user may always read their OWN membership, regardless of status — an
	// INVITED (not-yet-active) member must be able to see their pending
	// invitation. Reading someone else's membership requires an active membership.
	claims, err := o.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	if claims.GetSub() != req.GetUserId() {
		if _, err := o.authz.RequireOrgMember(ctx, orgID); err != nil {
			return nil, err
		}
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
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
		return nil, err
	}
	if _, err := o.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	members, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListOrganizationMembersRow, error) {
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
		out = append(out, OrganizationMemberRowToProto(m))
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
		return nil, err
	}

	members, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListUserMembershipsRow, error) {
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
		out = append(out, OrganizationMembershipRowToProto(m))
	}
	return &richterv1.ListUserMembershipsResponse{Members: out}, nil
}

func (o *OrgMembersSvc) UpdateOrganizationMemberRole(
	ctx context.Context,
	req *richterv1.UpdateOrganizationMemberRoleRequest,
) (*richterv1.UpdateOrganizationMemberRoleResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}
	role, err := OrganizationRoleToSQL(req.GetRole())
	if err != nil {
		return nil, err
	}

	// All permission checks and the update happen inside one transaction to eliminate TOCTOU.
	// Only ORG_OWNER may change an OWNER's role or promote anyone to OWNER.
	member, err := db.WithCommitTx(o.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.OrganizationMember, error) {
		current, err := q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gen.OrganizationMember{}, connect.NewError(connect.CodeNotFound, errors.New("member not found"))
			}
			return gen.OrganizationMember{}, connect.NewError(connect.CodeInternal, fmt.Errorf("get member: %w", err))
		}
		if current.Role == gen.OrganizationRoleOwner || role == gen.OrganizationRoleOwner {
			if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleOwner); err != nil {
				return gen.OrganizationMember{}, err
			}
		} else {
			if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
				return gen.OrganizationMember{}, err
			}
		}
		if current.Role == gen.OrganizationRoleOwner && role != gen.OrganizationRoleOwner && current.Status == gen.MemberStatusActive {
			ownerCount, err := q.CountOrganizationOwners(ctx, orgID)
			if err != nil {
				return gen.OrganizationMember{}, connect.NewError(connect.CodeInternal, fmt.Errorf("count owners: %w", err))
			}
			if ownerCount <= 1 {
				return gen.OrganizationMember{}, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot demote the last owner of an organization"))
			}
		}
		return q.UpdateOrganizationMemberRole(ctx, gen.UpdateOrganizationMemberRoleParams{
			OrganizationID: orgID,
			UserID:         userID,
			Role:           role,
		})
	})
	if err != nil {
		if connect.CodeOf(err) != connect.CodeUnknown {
			return nil, err
		}
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
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		return nil, err
	}
	status, err := MemberStatusToSQL(req.GetStatus())
	if err != nil {
		return nil, err
	}

	// All permission checks and the update happen inside one transaction to eliminate TOCTOU.
	// Only ORG_OWNER may change an OWNER's status; also prevents locking out the last owner.
	member, err := db.WithCommitTx(o.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.OrganizationMember, error) {
		current, err := q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gen.OrganizationMember{}, connect.NewError(connect.CodeNotFound, errors.New("member not found"))
			}
			return gen.OrganizationMember{}, connect.NewError(connect.CodeInternal, fmt.Errorf("get member: %w", err))
		}
		if current.Role == gen.OrganizationRoleOwner {
			if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleOwner); err != nil {
				return gen.OrganizationMember{}, err
			}
			if status != gen.MemberStatusActive && current.Status == gen.MemberStatusActive {
				ownerCount, err := q.CountOrganizationOwners(ctx, orgID)
				if err != nil {
					return gen.OrganizationMember{}, connect.NewError(connect.CodeInternal, fmt.Errorf("count owners: %w", err))
				}
				if ownerCount <= 1 {
					return gen.OrganizationMember{}, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot deactivate the last owner of an organization"))
				}
			}
		} else {
			if _, err := o.authz.RequireOrgRole(ctx, orgID, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
				return gen.OrganizationMember{}, err
			}
		}
		return q.UpdateOrganizationMemberStatus(ctx, gen.UpdateOrganizationMemberStatusParams{
			OrganizationID: orgID,
			UserID:         userID,
			Status:         status,
		})
	})
	if err != nil {
		if connect.CodeOf(err) != connect.CodeUnknown {
			return nil, err
		}
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
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
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

		if callerMember.Status != gen.MemberStatusActive {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("membership is not active"))
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
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, connect.NewError(connect.CodeNotFound, errors.New("member not found"))
				}
				return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("get member: %w", err))
			}
			if targetMember.Role == gen.OrganizationRoleOwner {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("org admin cannot remove owner"))
			}
		case gen.OrganizationRoleOwner:
			// owner can remove anyone, but cannot orphan the org
		}
	}

	// Last-owner guard + delete in one transaction to avoid TOCTOU race.
	rowsAffected, err := db.WithCommitTx(o.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (int64, error) {
		target, err := q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, connect.NewError(connect.CodeNotFound, fmt.Errorf("member not found: org=%s user=%s", orgID.String(), userID.String()))
			}
			return 0, connect.NewError(connect.CodeInternal, fmt.Errorf("get member: %w", err))
		}
		if target.Role == gen.OrganizationRoleOwner && target.Status == gen.MemberStatusActive {
			ownerCount, err := q.CountOrganizationOwners(ctx, orgID)
			if err != nil {
				return 0, connect.NewError(connect.CodeInternal, fmt.Errorf("count owners: %w", err))
			}
			if ownerCount <= 1 {
				return 0, connect.NewError(connect.CodeFailedPrecondition, errors.New("cannot remove the last owner of an organization"))
			}
		}
		// Cascade: drop the user's course memberships in this org in the SAME tx,
		// so losing org membership also revokes course access (no orphan
		// course_members row pointing at a user no longer in the org).
		if _, err := q.RemoveCourseMembershipsForUserInOrg(ctx, gen.RemoveCourseMembershipsForUserInOrgParams{
			OrganizationID: orgID,
			UserID:         userID,
		}); err != nil {
			return 0, connect.NewError(connect.CodeInternal, fmt.Errorf("cascade course memberships: %w", err))
		}
		return q.RemoveOrganizationMember(ctx, gen.RemoveOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
	})
	if err != nil {
		if connect.CodeOf(err) != connect.CodeUnknown {
			return nil, err
		}
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("RemoveOrganizationMember", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("member not found: org=%s user=%s", orgID.String(), userID.String()))
	}
	return &richterv1.RemoveOrganizationMemberResponse{}, nil
}

// RespondToOrganizationInvitation lets the authenticated caller accept or decline
// their OWN pending invitation. Accept flips status INVITED → ACTIVE; decline
// deletes the membership row. The caller can only act on their own invitation
// (the target user is the token subject — no user_id in the request).
func (o *OrgMembersSvc) RespondToOrganizationInvitation(
	ctx context.Context,
	req *richterv1.RespondToOrganizationInvitationRequest,
) (*richterv1.RespondToOrganizationInvitationResponse, error) {
	orgID, err := svc.ParseUUID(req.GetOrganizationId())
	if err != nil {
		return nil, err
	}
	claims, err := o.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	callerID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}

	// Read the caller's own membership, verify it's a pending invitation, then
	// accept (→ ACTIVE) or decline (delete) — all in one tx to avoid TOCTOU.
	member, err := db.WithCommitTx(o.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.OrganizationMember, error) {
		current, err := q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         callerID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gen.OrganizationMember{}, connect.NewError(connect.CodeNotFound, errors.New("no invitation for this organization"))
			}
			return gen.OrganizationMember{}, connect.NewError(connect.CodeInternal, fmt.Errorf("get member: %w", err))
		}
		if current.Status != gen.MemberStatusInvited {
			return gen.OrganizationMember{}, connect.NewError(connect.CodeFailedPrecondition, errors.New("no pending invitation to respond to"))
		}
		if !req.GetAccept() {
			if _, err := q.RemoveOrganizationMember(ctx, gen.RemoveOrganizationMemberParams{
				OrganizationID: orgID,
				UserID:         callerID,
			}); err != nil {
				return gen.OrganizationMember{}, connect.NewError(connect.CodeInternal, fmt.Errorf("decline invitation: %w", err))
			}
			return gen.OrganizationMember{}, nil
		}
		return q.UpdateOrganizationMemberStatus(ctx, gen.UpdateOrganizationMemberStatusParams{
			OrganizationID: orgID,
			UserID:         callerID,
			Status:         gen.MemberStatusActive,
		})
	})
	if err != nil {
		if connect.CodeOf(err) != connect.CodeUnknown {
			return nil, err
		}
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "org_members service failed", svc.LogAttrs("RespondToOrganizationInvitation", err)...)
		return nil, err
	}
	resp := &richterv1.RespondToOrganizationInvitationResponse{}
	if req.GetAccept() {
		resp.Member = OrganizationMemberToProto(member)
	}
	return resp, nil
}
