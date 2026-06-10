package ai

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
)

// authorizeAndLoadLesson validates auth + loads the lesson for analysis.
func (s *AISvc) authorizeAndLoadLesson(ctx context.Context, lessonIDStr string) (pgtype.UUID, string, error) {
	lessonID, err := svc.ParseUUID(lessonIDStr)
	if err != nil {
		return pgtype.UUID{}, "", err
	}
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return pgtype.UUID{}, "", svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return pgtype.UUID{}, "", err
	}
	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return pgtype.UUID{}, "", svc.ConnectDBError(err)
	}
	if !lesson.VideoStorageKey.Valid || lesson.VideoStorageKey.String == "" {
		return pgtype.UUID{}, "", connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("lesson has no video uploaded"))
	}
	if _, err := s.s3client.StatObject(ctx, s.s3cfg.Bucket, lesson.VideoStorageKey.String, minio.StatObjectOptions{}); err != nil {
		return pgtype.UUID{}, "", connect.NewError(connect.CodeNotFound, fmt.Errorf("video file not found in storage"))
	}
	return lessonID, lesson.VideoStorageKey.String, nil
}

// requireTeacherRole is a helper for RPCs that require teacher+ org role.
func (s *AISvc) requireTeacherRole(ctx context.Context, lessonID pgtype.UUID) error {
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return svc.ConnectDBError(err)
	}
	_, err = s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	)
	return err
}

func (s *AISvc) persistExtractError(ctx context.Context, lessonID pgtype.UUID, msg string) bool {
	// Legacy: previously wrote to lesson_analyses table. Now that
	// task status is derived from the tasks table, this is a no-op.
	// Kept as a dependency wired into transcript.Service until the
	// service interface is cleaned up.
	return true
}
