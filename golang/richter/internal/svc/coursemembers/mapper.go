package coursemembers

import (
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
)

func CourseMemberToProto(m gen.CourseMember) *richterv1.CourseMember {
	return &richterv1.CourseMember{
		CourseId:  m.CourseID.String(),
		UserId:    m.UserID.String(),
		Role:      CourseRoleToProto(m.Role),
		CreatedAt: svc.TimestampToProto(m.CreatedAt),
		UpdatedAt: svc.TimestampToProto(m.UpdatedAt),
	}
}

func CourseMemberRowToProto(m gen.ListCourseMembersRow) *richterv1.CourseMember {
	return &richterv1.CourseMember{
		CourseId:      m.CourseID.String(),
		UserId:        m.UserID.String(),
		Role:          CourseRoleToProto(m.Role),
		CreatedAt:     svc.TimestampToProto(m.CreatedAt),
		UpdatedAt:     svc.TimestampToProto(m.UpdatedAt),
		UserEmail:     m.UserEmail,
		UserFirstName: m.UserFirstName,
		UserLastName:  m.UserLastName,
	}
}

func CourseRoleToProto(role gen.CourseRole) richterv1.CourseRole {
	switch role {
	case gen.CourseRoleTeacher:
		return richterv1.CourseRole_COURSE_ROLE_TEACHER
	case gen.CourseRoleStudent:
		return richterv1.CourseRole_COURSE_ROLE_STUDENT
	default:
		return richterv1.CourseRole_COURSE_ROLE_UNSPECIFIED
	}
}

func CourseRoleToSQL(role richterv1.CourseRole) (gen.CourseRole, error) {
	switch role {
	case richterv1.CourseRole_COURSE_ROLE_TEACHER:
		return gen.CourseRoleTeacher, nil
	case richterv1.CourseRole_COURSE_ROLE_STUDENT:
		return gen.CourseRoleStudent, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid course role: %s", role.String()))
	}
}

func JoinRequestStatusToProto(status gen.JoinRequestStatus) richterv1.JoinRequestStatus {
	switch status {
	case gen.JoinRequestStatusPending:
		return richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_PENDING
	case gen.JoinRequestStatusApproved:
		return richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_APPROVED
	case gen.JoinRequestStatusRejected:
		return richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_REJECTED
	default:
		return richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_UNSPECIFIED
	}
}

func JoinRequestToProto(r gen.CourseJoinRequest) *richterv1.CourseJoinRequest {
	return &richterv1.CourseJoinRequest{
		CourseId:  r.CourseID.String(),
		UserId:    r.UserID.String(),
		Status:    JoinRequestStatusToProto(r.Status),
		CreatedAt: svc.TimestampToProto(r.CreatedAt),
		UpdatedAt: svc.TimestampToProto(r.UpdatedAt),
	}
}

func JoinRequestRowToProto(r gen.ListPendingJoinRequestsRow) *richterv1.CourseJoinRequest {
	return &richterv1.CourseJoinRequest{
		CourseId:      r.CourseID.String(),
		UserId:        r.UserID.String(),
		Status:        JoinRequestStatusToProto(r.Status),
		CreatedAt:     svc.TimestampToProto(r.CreatedAt),
		UpdatedAt:     svc.TimestampToProto(r.UpdatedAt),
		UserEmail:     r.UserEmail,
		UserFirstName: r.UserFirstName,
		UserLastName:  r.UserLastName,
	}
}

