package lessons

import (
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
)

func LessonToProto(l gen.Lesson) *richterv1.Lesson {
	desc := ""
	if l.Description.Valid {
		desc = l.Description.String
	}
	videoKey := ""
	if l.VideoStorageKey.Valid {
		videoKey = l.VideoStorageKey.String
	}
	duration := int32(0)
	if l.DurationSeconds.Valid {
		duration = l.DurationSeconds.Int32
	}
	return &richterv1.Lesson{
		Id:               l.ID.String(),
		ModuleId:         l.ModuleID.String(),
		Title:            l.Title,
		Description:      desc,
		OrderIndex:       l.OrderIndex,
		VideoStorageKey:  videoKey,
		DurationSeconds:  duration,
		FeedbackMode:     interactions.FeedbackModeToProto(l.FeedbackMode),
		Language:         l.Language,
		MaxAttempts:      l.MaxAttempts,
		MinWatchFraction: float64(l.MinWatchFraction),
		MinScoreFraction: float64(l.MinScoreFraction),
		CreatedAt:        svc.TimestampToProto(l.CreatedAt),
		UpdatedAt:        svc.TimestampToProto(l.UpdatedAt),
	}
}

func FeedbackModeFromProto(mode richterv1.FeedbackMode) string {
	return interactions.FeedbackModeFromProto(mode)
}
