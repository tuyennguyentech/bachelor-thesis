package seed

import (
	"context"
	"fmt"

	"errors"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	usersvc "example.com/richter/internal/svc/users"
	"example.com/sql/gen"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var userRoleProto = map[string]richterv1.UserRole{
	"normal": richterv1.UserRole_USER_ROLE_NORMAL,
	"admin":  richterv1.UserRole_USER_ROLE_ADMIN,
}

var userStatusProto = map[string]richterv1.UserStatus{
	"active":   richterv1.UserStatus_USER_STATUS_ACTIVE,
	"pending":  richterv1.UserStatus_USER_STATUS_PENDING,
	"disabled": richterv1.UserStatus_USER_STATUS_DISABLED,
}

// seedDevUsers creates dev users THROUGH UsersSvc.CreateUserWithRoleAndStatus with
// synthesized SYS-ADMIN auth (the bootstrap admin from seedAdmin), not a raw
// insert: the service validates the input and hashes the password exactly like
// registration, so the rows are consistent with production by construction.
func (s *SeederSvc) seedDevUsers(ctx context.Context, users []devUserSpec) error {
	usvc, err := do.Invoke[*usersvc.UsersSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke UsersSvc: %w", err)
	}
	admin, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByEmail(ctx, s.admin.Email)
	})
	if err != nil {
		return fmt.Errorf("lookup bootstrap admin %s: %w", s.admin.Email, err)
	}
	adminCtx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
		Sub:    uuidStr(admin.ID),
		Role:   richterv1.UserRole_USER_ROLE_ADMIN,
		Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	for _, u := range users {
		role, ok := userRoleProto[u.Role]
		if !ok {
			return fmt.Errorf("user %s: unknown role %q", u.Email, u.Role)
		}
		status, ok := userStatusProto[u.Status]
		if !ok {
			return fmt.Errorf("user %s: unknown status %q", u.Email, u.Status)
		}
		// Declarative desired-state (Terraform/Ansible style): probe by unique email.
		// If present, CONVERGE the row to the spec (update only drifted fields); if
		// absent, INSERT. Either way the end state equals the spec, idempotently — and
		// a real lookup failure (not "no rows") is a genuine error → STOP.
		existing, lookupErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, u.Email)
		})
		if lookupErr == nil {
			if err := s.convergeDevUser(adminCtx, usvc, existing, u, role, status); err != nil {
				return err
			}
			continue
		}
		if !errors.Is(lookupErr, pgx.ErrNoRows) {
			return fmt.Errorf("lookup user %s: %w", u.Email, lookupErr)
		}
		if _, err := usvc.CreateUserWithRoleAndStatus(adminCtx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     u.Email,
			Password:  u.Password,
			FirstName: u.FirstName,
			LastName:  u.LastName,
			Role:      role,
			Status:    status,
		}); err != nil {
			return fmt.Errorf("create user %s: %w", u.Email, err)
		}
		s.log.InfoContext(ctx, "seed: dev user created", "email", u.Email)
	}
	return nil
}

// convergeDevUser brings an EXISTING user row to the spec's desired state, updating
// only the fields that actually differ (so a matched re-run writes nothing). All
// updates go through UsersSvc; the bootstrap admin context satisfies every guard
// (RequireSelf also accepts an admin caller). Password is intentionally not
// reconciled — it can't be compared against its hash and re-hashing every run would
// churn the row; it's set once at creation.
func (s *SeederSvc) convergeDevUser(adminCtx context.Context, usvc *usersvc.UsersSvc, cur gen.User, spec devUserSpec, wantRole richterv1.UserRole, wantStatus richterv1.UserStatus) error {
	id := uuidStr(cur.ID)
	curProto := usersvc.UserToProto(cur)
	if curProto.GetFirstName() != spec.FirstName || curProto.GetLastName() != spec.LastName {
		if _, err := usvc.UpdateUserProfile(adminCtx, &richterv1.UpdateUserProfileRequest{
			Id: id, FirstName: spec.FirstName, LastName: spec.LastName,
		}); err != nil {
			return fmt.Errorf("converge profile for user %s: %w", spec.Email, err)
		}
		s.log.InfoContext(adminCtx, "seed: dev user profile converged", "email", spec.Email)
	}
	if curProto.GetRole() != wantRole {
		if _, err := usvc.UpdateUserRole(adminCtx, &richterv1.UpdateUserRoleRequest{Id: id, Role: wantRole}); err != nil {
			return fmt.Errorf("converge role for user %s: %w", spec.Email, err)
		}
		s.log.InfoContext(adminCtx, "seed: dev user role converged", "email", spec.Email, "role", spec.Role)
	}
	if curProto.GetStatus() != wantStatus {
		if _, err := usvc.UpdateUserStatus(adminCtx, &richterv1.UpdateUserStatusRequest{Id: id, Status: wantStatus}); err != nil {
			return fmt.Errorf("converge status for user %s: %w", spec.Email, err)
		}
		s.log.InfoContext(adminCtx, "seed: dev user status converged", "email", spec.Email, "status", spec.Status)
	}
	return nil
}
