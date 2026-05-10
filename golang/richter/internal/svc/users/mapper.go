package users

import (
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	svc "example.com/richter/internal/svc"
	"example.com/sql/gen"
)

func UserToProto(user gen.User) *richterv1.User {
	return &richterv1.User{
		Id:         user.ID.String(),
		Email:      user.Email,
		FirstName:  user.FirstName,
		MiddleName: svc.PgTextToOptionalString(user.MiddleName),
		LastName:   user.LastName,
		Role:       UserRoleToProto(user.Role),
		Status:     UserStatusToProto(user.Status),
		CreatedAt:  svc.TimestampToProto(user.CreatedAt),
		UpdatedAt:  svc.TimestampToProto(user.UpdatedAt),
	}
}

func UserRoleToProto(role gen.UserRole) richterv1.UserRole {
	switch role {
	case gen.UserRoleNormal:
		return richterv1.UserRole_USER_ROLE_NORMAL
	case gen.UserRoleAdmin:
		return richterv1.UserRole_USER_ROLE_ADMIN
	default:
		return richterv1.UserRole_USER_ROLE_UNSPECIFIED
	}
}

func UserRoleToSQL(role richterv1.UserRole) (gen.UserRole, error) {
	switch role {
	case richterv1.UserRole_USER_ROLE_NORMAL:
		return gen.UserRoleNormal, nil
	case richterv1.UserRole_USER_ROLE_ADMIN:
		return gen.UserRoleAdmin, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid user role: %s", role.String()))
	}
}

func UserStatusToProto(status gen.UserStatus) richterv1.UserStatus {
	switch status {
	case gen.UserStatusPending:
		return richterv1.UserStatus_USER_STATUS_PENDING
	case gen.UserStatusActive:
		return richterv1.UserStatus_USER_STATUS_ACTIVE
	case gen.UserStatusDisabled:
		return richterv1.UserStatus_USER_STATUS_DISABLED
	default:
		return richterv1.UserStatus_USER_STATUS_UNSPECIFIED
	}
}

func UserStatusToSQL(status richterv1.UserStatus) (gen.UserStatus, error) {
	switch status {
	case richterv1.UserStatus_USER_STATUS_PENDING:
		return gen.UserStatusPending, nil
	case richterv1.UserStatus_USER_STATUS_ACTIVE:
		return gen.UserStatusActive, nil
	case richterv1.UserStatus_USER_STATUS_DISABLED:
		return gen.UserStatusDisabled, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid user status: %s", status.String()))
	}
}
