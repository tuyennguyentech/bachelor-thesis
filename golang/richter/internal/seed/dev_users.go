package seed

import (
	"context"
	"fmt"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	usersvc "example.com/richter/internal/svc/users"
	"example.com/sql/gen"

	"connectrpc.com/connect"
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
		_, err := usvc.CreateUserWithRoleAndStatus(adminCtx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     u.Email,
			Password:  u.Password,
			FirstName: u.FirstName,
			LastName:  u.LastName,
			Role:      role,
			Status:    status,
		})
		if err == nil {
			s.log.InfoContext(ctx, "seed: dev user created", "email", u.Email)
			continue
		}
		if connect.CodeOf(err) == connect.CodeAlreadyExists {
			s.log.InfoContext(ctx, "seed: dev user already exists, skipping", "email", u.Email)
			continue
		}
		return fmt.Errorf("create user %s: %w", u.Email, err)
	}
	return nil
}
