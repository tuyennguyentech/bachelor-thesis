package ai

import (
	"context"
	"fmt"
	"time"

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
	write := func(writeCtx context.Context) error {
		return db.WithConnectionExec(s.pg, writeCtx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			_, err := q.UpsertLessonAnalysisStatus(writeCtx, gen.UpsertLessonAnalysisStatusParams{
				LessonID: lessonID,
				Status:   gen.LessonAnalysisStatusError,
				ErrorMsg: pgtype.Text{String: msg, Valid: true},
			})
			return err
		})
	}

	if err := write(ctx); err != nil {
		if ctx.Err() == nil {
			s.log.ErrorContext(ctx, "ai: failed to persist transcript extraction error", "err", err)
			return false
		}
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if bgErr := write(bgCtx); bgErr != nil {
			s.log.ErrorContext(bgCtx, "ai: failed to persist transcript extraction error after request cancellation", "err", bgErr)
			return false
		}
	}
	return true
}
