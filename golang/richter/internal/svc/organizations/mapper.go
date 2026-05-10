package organizations

import (
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
)

func OrganizationToProto(org gen.Organization) *richterv1.Organization {
	return &richterv1.Organization{
		Id:        org.ID.String(),
		CreatedBy: org.CreatedBy.String(),
		Name:      org.Name,
		Slug:      org.Slug,
		Status:    OrganizationStatusToProto(org.Status),
		CreatedAt: svc.TimestampToProto(org.CreatedAt),
		UpdatedAt: svc.TimestampToProto(org.UpdatedAt),
	}
}

func OrganizationStatusToProto(status gen.OrganizationStatus) richterv1.OrganizationStatus {
	switch status {
	case gen.OrganizationStatusActive:
		return richterv1.OrganizationStatus_ORGANIZATION_STATUS_ACTIVE
	case gen.OrganizationStatusSuspended:
		return richterv1.OrganizationStatus_ORGANIZATION_STATUS_SUSPENDED
	case gen.OrganizationStatusArchived:
		return richterv1.OrganizationStatus_ORGANIZATION_STATUS_ARCHIVED
	default:
		return richterv1.OrganizationStatus_ORGANIZATION_STATUS_UNSPECIFIED
	}
}

func OrganizationStatusToSQL(status richterv1.OrganizationStatus) (gen.OrganizationStatus, error) {
	switch status {
	case richterv1.OrganizationStatus_ORGANIZATION_STATUS_ACTIVE:
		return gen.OrganizationStatusActive, nil
	case richterv1.OrganizationStatus_ORGANIZATION_STATUS_SUSPENDED:
		return gen.OrganizationStatusSuspended, nil
	case richterv1.OrganizationStatus_ORGANIZATION_STATUS_ARCHIVED:
		return gen.OrganizationStatusArchived, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid organization status: %s", status.String()))
	}
}
