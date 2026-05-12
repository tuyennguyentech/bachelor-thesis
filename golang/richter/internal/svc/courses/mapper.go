package courses

import (
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
)

func CourseToProto(c gen.Course) *richterv1.Course {
	desc := ""
	if c.Description.Valid {
		desc = c.Description.String
	}
	return &richterv1.Course{
		Id:             c.ID.String(),
		OrganizationId: c.OrganizationID.String(),
		OwnerId:        c.OwnerID.String(),
		Title:          c.Title,
		Description:    desc,
		Status:         CourseStatusToProto(c.Status),
		CreatedAt:      svc.TimestampToProto(c.CreatedAt),
		UpdatedAt:      svc.TimestampToProto(c.UpdatedAt),
	}
}

func CourseStatusToProto(status gen.CourseStatus) richterv1.CourseStatus {
	switch status {
	case gen.CourseStatusDraft:
		return richterv1.CourseStatus_COURSE_STATUS_DRAFT
	case gen.CourseStatusPublished:
		return richterv1.CourseStatus_COURSE_STATUS_PUBLISHED
	case gen.CourseStatusArchived:
		return richterv1.CourseStatus_COURSE_STATUS_ARCHIVED
	default:
		return richterv1.CourseStatus_COURSE_STATUS_UNSPECIFIED
	}
}

func CourseStatusToSQL(status richterv1.CourseStatus) (gen.CourseStatus, error) {
	switch status {
	case richterv1.CourseStatus_COURSE_STATUS_DRAFT:
		return gen.CourseStatusDraft, nil
	case richterv1.CourseStatus_COURSE_STATUS_PUBLISHED:
		return gen.CourseStatusPublished, nil
	case richterv1.CourseStatus_COURSE_STATUS_ARCHIVED:
		return gen.CourseStatusArchived, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid course status: %s", status.String()))
	}
}

func descriptionToPgText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
}

