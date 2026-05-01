package users

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	svc "example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewUsersSvc),
)

func init() {
	Package(internal.Injector)
}

type UsersSvc struct {
	pg *db.PostgresSvc
}

var _ richterv1connect.UserServiceHandler = (*UsersSvc)(nil)

func NewUsersSvc(i do.Injector) (u *UsersSvc, err error) {
	u = new(UsersSvc)
	u.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	return
}

func (u *UsersSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewUserServiceHandler(u)
}

func (u *UsersSvc) logAndReturnErr(ctx context.Context, operation string, err error) error {
	log.FromCtx(ctx).LogAttrs(
		ctx,
		slog.LevelError,
		"users service request failed",
		slog.String("operation", operation),
		slog.String("code", connect.CodeOf(err).String()),
		slog.Any("error", err),
	)
	return err
}

func (u *UsersSvc) logAndReturnDBErr(ctx context.Context, operation string, err error) error {
	return u.logAndReturnErr(ctx, operation, svc.ConnectDBError(err))
}

func (u *UsersSvc) logAndReturnInternalErr(ctx context.Context, operation string, err error) error {
	return u.logAndReturnErr(ctx, operation, connect.NewError(connect.CodeInternal, err))
}

func (u *UsersSvc) CreateUser(
	ctx context.Context,
	req *richterv1.CreateUserRequest,
) (*richterv1.CreateUserResponse, error) {
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		return nil, u.logAndReturnInternalErr(ctx, "CreateUser.HashPassword", err)
	}
	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.CreateUser(ctx, gen.CreateUserParams{
			Email:        req.GetEmail(),
			PasswordHash: passwordHash,
			FirstName:    req.GetFirstName(),
			MiddleName:   svc.OptionalStringToPgText(req.MiddleName),
			LastName:     req.GetLastName(),
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "CreateUser", err)
	}
	return &richterv1.CreateUserResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) CreateUserWithRoleAndStatus(
	ctx context.Context,
	req *richterv1.CreateUserWithRoleAndStatusRequest,
) (*richterv1.CreateUserWithRoleAndStatusResponse, error) {
	role, err := userRoleToSQL(req.GetRole())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "CreateUserWithRoleAndStatus.UserRoleToSQL", err)
	}
	status, err := userStatusToSQL(req.GetStatus())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "CreateUserWithRoleAndStatus.UserStatusToSQL", err)
	}
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		return nil, u.logAndReturnInternalErr(ctx, "CreateUserWithRoleAndStatus.HashPassword", err)
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.CreateUserWithRoleAndStatus(ctx, gen.CreateUserWithRoleAndStatusParams{
			Email:        req.GetEmail(),
			PasswordHash: passwordHash,
			FirstName:    req.GetFirstName(),
			MiddleName:   svc.OptionalStringToPgText(req.MiddleName),
			LastName:     req.GetLastName(),
			Role:         role,
			Status:       status,
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "CreateUserWithRoleAndStatus", err)
	}
	return &richterv1.CreateUserWithRoleAndStatusResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) GetUserById(
	ctx context.Context,
	req *richterv1.GetUserByIdRequest,
) (*richterv1.GetUserByIdResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "GetUserById.ParseUUID", err)
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByID(ctx, id)
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "GetUserById", err)
	}
	return &richterv1.GetUserByIdResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) GetUserByEmail(
	ctx context.Context,
	req *richterv1.GetUserByEmailRequest,
) (*richterv1.GetUserByEmailResponse, error) {
	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByEmail(ctx, req.GetEmail())
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "GetUserByEmail", err)
	}
	return &richterv1.GetUserByEmailResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) ListUsers(
	ctx context.Context,
	req *richterv1.ListUsersRequest,
) (*richterv1.ListUsersResponse, error) {
	users, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.User, error) {
		return q.ListUsers(ctx, gen.ListUsersParams{
			Limit:  req.GetLimit(),
			Offset: req.GetOffset(),
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "ListUsers", err)
	}

	out := make([]*richterv1.User, 0, len(users))
	for _, user := range users {
		out = append(out, userToProto(user))
	}
	return &richterv1.ListUsersResponse{Users: out}, nil
}

func (u *UsersSvc) UpdateUserProfile(
	ctx context.Context,
	req *richterv1.UpdateUserProfileRequest,
) (*richterv1.UpdateUserProfileResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "UpdateUserProfile.ParseUUID", err)
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserProfile(ctx, gen.UpdateUserProfileParams{
			ID:         id,
			FirstName:  req.GetFirstName(),
			MiddleName: svc.OptionalStringToPgText(req.MiddleName),
			LastName:   req.GetLastName(),
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "UpdateUserProfile", err)
	}
	return &richterv1.UpdateUserProfileResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) UpdateUserPassword(
	ctx context.Context,
	req *richterv1.UpdateUserPasswordRequest,
) (*richterv1.UpdateUserPasswordResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "UpdateUserPassword.ParseUUID", err)
	}
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		return nil, u.logAndReturnInternalErr(ctx, "UpdateUserPassword.HashPassword", err)
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserPassword(ctx, gen.UpdateUserPasswordParams{
			ID:           id,
			PasswordHash: passwordHash,
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "UpdateUserPassword", err)
	}
	return &richterv1.UpdateUserPasswordResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) UpdateUserRole(
	ctx context.Context,
	req *richterv1.UpdateUserRoleRequest,
) (*richterv1.UpdateUserRoleResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "UpdateUserRole.ParseUUID", err)
	}
	role, err := userRoleToSQL(req.GetRole())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "UpdateUserRole.UserRoleToSQL", err)
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserRole(ctx, gen.UpdateUserRoleParams{
			ID:   id,
			Role: role,
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "UpdateUserRole", err)
	}
	return &richterv1.UpdateUserRoleResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) UpdateUserStatus(
	ctx context.Context,
	req *richterv1.UpdateUserStatusRequest,
) (*richterv1.UpdateUserStatusResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "UpdateUserStatus.ParseUUID", err)
	}
	status, err := userStatusToSQL(req.GetStatus())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "UpdateUserStatus.UserStatusToSQL", err)
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserStatus(ctx, gen.UpdateUserStatusParams{
			ID:     id,
			Status: status,
		})
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "UpdateUserStatus", err)
	}
	return &richterv1.UpdateUserStatusResponse{User: userToProto(user)}, nil
}

func (u *UsersSvc) DeleteUser(
	ctx context.Context,
	req *richterv1.DeleteUserRequest,
) (*richterv1.DeleteUserResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, u.logAndReturnErr(ctx, "DeleteUser.ParseUUID", err)
	}

	rowsAffected, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.DeleteUser(ctx, id)
	})
	if err != nil {
		return nil, u.logAndReturnDBErr(ctx, "DeleteUser", err)
	}
	if rowsAffected == 0 {
		return nil, u.logAndReturnErr(
			ctx,
			"DeleteUser.NotFound",
			connect.NewError(connect.CodeNotFound, fmt.Errorf("user not found: %s", id.String())),
		)
	}
	return &richterv1.DeleteUserResponse{}, nil
}
