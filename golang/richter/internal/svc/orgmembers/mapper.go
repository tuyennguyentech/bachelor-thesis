package orgmembers

import (
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
)

func OrganizationMemberToProto(m gen.OrganizationMember) *richterv1.OrganizationMember {
	return &richterv1.OrganizationMember{
		OrganizationId: m.OrganizationID.String(),
		UserId:         m.UserID.String(),
		Role:           OrganizationRoleToProto(m.Role),
		Status:         MemberStatusToProto(m.Status),
		CreatedAt:      svc.TimestampToProto(m.CreatedAt),
		UpdatedAt:      svc.TimestampToProto(m.UpdatedAt),
	}
}

func OrganizationMemberRowToProto(m gen.ListOrganizationMembersRow) *richterv1.OrganizationMember {
	return &richterv1.OrganizationMember{
		OrganizationId: m.OrganizationID.String(),
		UserId:         m.UserID.String(),
		Role:           OrganizationRoleToProto(m.Role),
		Status:         MemberStatusToProto(m.Status),
		CreatedAt:      svc.TimestampToProto(m.CreatedAt),
		UpdatedAt:      svc.TimestampToProto(m.UpdatedAt),
		UserEmail:      m.UserEmail,
		UserFirstName:  m.UserFirstName,
		UserLastName:   m.UserLastName,
	}
}

func OrganizationRoleToProto(role gen.OrganizationRole) richterv1.OrganizationRole {
	switch role {
	case gen.OrganizationRoleOwner:
		return richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER
	case gen.OrganizationRoleAdmin:
		return richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN
	case gen.OrganizationRoleTeacher:
		return richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER
	case gen.OrganizationRoleStudent:
		return richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT
	default:
		return richterv1.OrganizationRole_ORGANIZATION_ROLE_UNSPECIFIED
	}
}

func OrganizationRoleToSQL(role richterv1.OrganizationRole) (gen.OrganizationRole, error) {
	switch role {
	case richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER:
		return gen.OrganizationRoleOwner, nil
	case richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN:
		return gen.OrganizationRoleAdmin, nil
	case richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER:
		return gen.OrganizationRoleTeacher, nil
	case richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT:
		return gen.OrganizationRoleStudent, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid organization role: %s", role.String()))
	}
}

func MemberStatusToProto(status gen.MemberStatus) richterv1.MemberStatus {
	switch status {
	case gen.MemberStatusActive:
		return richterv1.MemberStatus_MEMBER_STATUS_ACTIVE
	case gen.MemberStatusInvited:
		return richterv1.MemberStatus_MEMBER_STATUS_INVITED
	case gen.MemberStatusSuspended:
		return richterv1.MemberStatus_MEMBER_STATUS_SUSPENDED
	default:
		return richterv1.MemberStatus_MEMBER_STATUS_UNSPECIFIED
	}
}

func MemberStatusToSQL(status richterv1.MemberStatus) (gen.MemberStatus, error) {
	switch status {
	case richterv1.MemberStatus_MEMBER_STATUS_ACTIVE:
		return gen.MemberStatusActive, nil
	case richterv1.MemberStatus_MEMBER_STATUS_INVITED:
		return gen.MemberStatusInvited, nil
	case richterv1.MemberStatus_MEMBER_STATUS_SUSPENDED:
		return gen.MemberStatusSuspended, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid member status: %s", status.String()))
	}
}
