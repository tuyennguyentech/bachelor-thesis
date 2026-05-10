package users

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
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
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.UserServiceHandler = (*UsersSvc)(nil)

func NewUsersSvc(i do.Injector) (u *UsersSvc, err error) {
	u = new(UsersSvc)
	u.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	u.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	u.authz, err = do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	return
}

func (u *UsersSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewUserServiceHandler(
		u,
		connect.WithInterceptors(validate.NewInterceptor(), u.authz.Interceptor()),
	)
}


func (u *UsersSvc) RegisterUser(
	ctx context.Context,
	req *richterv1.RegisterUserRequest,
) (*richterv1.RegisterUserResponse, error) {
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("RegisterUser.HashPassword", err)...)
		return nil, err
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
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("RegisterUser", err)...)
		return nil, err
	}
	return &richterv1.RegisterUserResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) CreateUser(
	ctx context.Context,
	req *richterv1.CreateUserRequest,
) (*richterv1.CreateUserResponse, error) {
	if _, err := u.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("CreateUser.HashPassword", err)...)
		return nil, err
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
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("CreateUser", err)...)
		return nil, err
	}
	return &richterv1.CreateUserResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) CreateUserWithRoleAndStatus(
	ctx context.Context,
	req *richterv1.CreateUserWithRoleAndStatusRequest,
) (*richterv1.CreateUserWithRoleAndStatusResponse, error) {
	if _, err := u.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}
	role, err := UserRoleToSQL(req.GetRole())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("CreateUserWithRoleAndStatus.UserRoleToSQL", err)...)
		return nil, err
	}
	status, err := UserStatusToSQL(req.GetStatus())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("CreateUserWithRoleAndStatus.UserStatusToSQL", err)...)
		return nil, err
	}
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("CreateUserWithRoleAndStatus.HashPassword", err)...)
		return nil, err
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
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("CreateUserWithRoleAndStatus", err)...)
		return nil, err
	}
	return &richterv1.CreateUserWithRoleAndStatusResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) GetUserById(
	ctx context.Context,
	req *richterv1.GetUserByIdRequest,
) (*richterv1.GetUserByIdResponse, error) {
	if _, err := u.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("GetUserById.ParseUUID", err)...)
		return nil, err
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByID(ctx, id)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("GetUserById", err)...)
		return nil, err
	}
	return &richterv1.GetUserByIdResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) GetUserByEmail(
	ctx context.Context,
	req *richterv1.GetUserByEmailRequest,
) (*richterv1.GetUserByEmailResponse, error) {
	claims, err := u.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	if claims.GetEmail() != req.GetEmail() && claims.GetRole() != richterv1.UserRole_USER_ROLE_ADMIN {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
	}
	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByEmail(ctx, req.GetEmail())
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("GetUserByEmail", err)...)
		return nil, err
	}
	return &richterv1.GetUserByEmailResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) ListUsers(
	ctx context.Context,
	req *richterv1.ListUsersRequest,
) (*richterv1.ListUsersResponse, error) {
	if _, err := u.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}

	var users []gen.User
	var err error
	if q := req.GetQuery(); q != "" {
		if id, uuidErr := svc.ParseUUID(q); uuidErr == nil {
			var user gen.User
			user, err = db.WithConnection(u.pg, ctx, func(queries *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
				return queries.GetUserByID(ctx, id)
			})
			if err == nil {
				users = []gen.User{user}
			} else if errors.Is(err, pgx.ErrNoRows) {
				users, err = []gen.User{}, nil
			}
		} else if strings.Contains(q, "@") {
			var user gen.User
			user, err = db.WithConnection(u.pg, ctx, func(queries *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
				return queries.GetUserByEmail(ctx, q)
			})
			if err == nil {
				users = []gen.User{user}
			} else if errors.Is(err, pgx.ErrNoRows) {
				users, err = []gen.User{}, nil
			}
		} else {
			users = []gen.User{}
		}
	} else {
		users, err = db.WithConnection(u.pg, ctx, func(queries *gen.Queries, _ *pgxpool.Conn) ([]gen.User, error) {
			return queries.ListUsers(ctx, gen.ListUsersParams{
				Limit:  req.GetLimit(),
				Offset: req.GetOffset(),
			})
		})
	}
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("ListUsers", err)...)
		return nil, err
	}

	out := make([]*richterv1.User, 0, len(users))
	for _, user := range users {
		out = append(out, UserToProto(user))
	}
	return &richterv1.ListUsersResponse{Users: out}, nil
}

func (u *UsersSvc) UpdateUserProfile(
	ctx context.Context,
	req *richterv1.UpdateUserProfileRequest,
) (*richterv1.UpdateUserProfileResponse, error) {
	if _, err := u.authz.RequireSelf(ctx, req.GetId()); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserProfile.ParseUUID", err)...)
		return nil, err
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
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserProfile", err)...)
		return nil, err
	}
	return &richterv1.UpdateUserProfileResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) UpdateUserPassword(
	ctx context.Context,
	req *richterv1.UpdateUserPasswordRequest,
) (*richterv1.UpdateUserPasswordResponse, error) {
	if _, err := u.authz.RequireSelf(ctx, req.GetId()); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserPassword.ParseUUID", err)...)
		return nil, err
	}
	passwordHash, err := secure.HashPassword(req.GetPassword())
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserPassword.HashPassword", err)...)
		return nil, err
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserPassword(ctx, gen.UpdateUserPasswordParams{
			ID:           id,
			PasswordHash: passwordHash,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserPassword", err)...)
		return nil, err
	}
	return &richterv1.UpdateUserPasswordResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) UpdateUserRole(
	ctx context.Context,
	req *richterv1.UpdateUserRoleRequest,
) (*richterv1.UpdateUserRoleResponse, error) {
	if _, err := u.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserRole.ParseUUID", err)...)
		return nil, err
	}
	role, err := UserRoleToSQL(req.GetRole())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserRole.UserRoleToSQL", err)...)
		return nil, err
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserRole(ctx, gen.UpdateUserRoleParams{
			ID:   id,
			Role: role,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserRole", err)...)
		return nil, err
	}
	return &richterv1.UpdateUserRoleResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) UpdateUserStatus(
	ctx context.Context,
	req *richterv1.UpdateUserStatusRequest,
) (*richterv1.UpdateUserStatusResponse, error) {
	if _, err := u.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserStatus.ParseUUID", err)...)
		return nil, err
	}
	status, err := UserStatusToSQL(req.GetStatus())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserStatus.UserStatusToSQL", err)...)
		return nil, err
	}

	user, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.UpdateUserStatus(ctx, gen.UpdateUserStatusParams{
			ID:     id,
			Status: status,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("UpdateUserStatus", err)...)
		return nil, err
	}
	return &richterv1.UpdateUserStatusResponse{User: UserToProto(user)}, nil
}

func (u *UsersSvc) DeleteUser(
	ctx context.Context,
	req *richterv1.DeleteUserRequest,
) (*richterv1.DeleteUserResponse, error) {
	if _, err := u.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("DeleteUser.ParseUUID", err)...)
		return nil, err
	}

	rowsAffected, err := db.WithConnection(u.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.DeleteUser(ctx, id)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("DeleteUser", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("user not found: %s", id.String()))
		u.log.ErrorContext(ctx, "users service failed", svc.LogAttrs("DeleteUser.NotFound", err)...)
		return nil, err
	}
	return &richterv1.DeleteUserResponse{}, nil
}
