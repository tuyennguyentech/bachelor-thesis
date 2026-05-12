package lessons

import (
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
)

func LessonToProto(l gen.Lesson) *richterv1.Lesson {
	desc := ""
	if l.Description.Valid {
		desc = l.Description.String
	}
	return &richterv1.Lesson{
		Id:          l.ID.String(),
		ModuleId:    l.ModuleID.String(),
		Title:       l.Title,
		Description: desc,
		OrderIndex:  l.OrderIndex,
		CreatedAt:   svc.TimestampToProto(l.CreatedAt),
		UpdatedAt:   svc.TimestampToProto(l.UpdatedAt),
	}
}
