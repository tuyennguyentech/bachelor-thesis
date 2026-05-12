package coursemodules

import (
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
)

func CourseModuleToProto(m gen.CourseModule) *richterv1.CourseModule {
	return &richterv1.CourseModule{
		Id:         m.ID.String(),
		CourseId:   m.CourseID.String(),
		Title:      m.Title,
		OrderIndex: m.OrderIndex,
		CreatedAt:  svc.TimestampToProto(m.CreatedAt),
		UpdatedAt:  svc.TimestampToProto(m.UpdatedAt),
	}
}
