package lessons

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
)

func (s *LessonsSvc) UpdateLessonVideo(
	ctx context.Context,
	req *richterv1.UpdateLessonVideoRequest,
) (*richterv1.UpdateLessonVideoResponse, error) {
	existing, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo.fetch", err)...)
		return nil, err
	}
	module, err := s.fetchModule(ctx, existing.ModuleID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}
	if err := validateLessonVideoKey(existing.ID.String(), req.GetVideoStorageKey()); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if _, err := s.s3client.StatObject(ctx, s.s3cfg.Bucket, req.GetVideoStorageKey(), minio.StatObjectOptions{}); err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("video file not found in storage"))
	}

	// Collect chunk IDs before the transaction so we can clean up FDB after the PG delete.
	var chunkIDsToClean []string
	if existing.VideoStorageKey.Valid {
		chunks, cerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
			return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
				LessonID: existing.ID,
				Limit:    int32(s.lessCfg.ListLimit),
				Offset:   0,
			})
		})
		if cerr == nil {
			for _, c := range chunks {
				chunkIDsToClean = append(chunkIDsToClean, c.ID.String())
			}
		}
	}

	// All mutations in one transaction: update video + clear stale analysis data atomically.
	l, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, tx pgx.Tx) (gen.Lesson, error) {
		updated, err := q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
			ID:              existing.ID,
			VideoStorageKey: pgtype.Text{String: req.GetVideoStorageKey(), Valid: true},
			DurationSeconds: pgtype.Int4{Int32: req.GetDurationSeconds(), Valid: req.GetDurationSeconds() > 0},
		})
		if err != nil {
			return gen.Lesson{}, err
		}
		// Always reset analysis when a video is (re-)uploaded. The storage key is
		// deterministic (lessons/<id>/video.ext), so same-filename replacements produce
		// the same key yet different content — we must still clear stale analysis data.
		if existing.VideoStorageKey.Valid {
			if err := q.DeleteLessonAttempts(ctx, existing.ID); err != nil {
				return gen.Lesson{}, err
			}
			if err := q.DeleteLessonInteractionsByLesson(ctx, existing.ID); err != nil {
				return gen.Lesson{}, err
			}
			if err := q.DeleteLessonTranscriptChunks(ctx, existing.ID); err != nil {
				return gen.Lesson{}, err
			}
			if err := q.DeleteTasksForLesson(ctx, existing.ID); err != nil {
				return gen.Lesson{}, err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM lesson_analyses WHERE lesson_id = $1", existing.ID); err != nil {
				return gen.Lesson{}, err
			}
		}
		return updated, nil
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLessonVideo", err)...)
		return nil, err
	}

	// Clean up orphaned FDB data after the PG transaction succeeds.
	if existing.VideoStorageKey.Valid {
		lessonIDStr := existing.ID.String()
		_ = s.kv.Delete(segment.NsLesson, tuple.Tuple{lessonIDStr, "transcript"})
		_ = s.kv.Delete(segment.NsLesson, tuple.Tuple{lessonIDStr, "segments"})
		for _, id := range chunkIDsToClean {
			_ = s.kv.Delete(segment.NsChunk, tuple.Tuple{id, "transcript"})
		}
	}

	// Delete the old S3 object when the storage key actually changes (e.g.
	// replacing video.mp4 with video.webm). Same-key replacements have already
	// overwritten the file via presigned PUT and need no cleanup.
	if existing.VideoStorageKey.Valid && existing.VideoStorageKey.String != req.GetVideoStorageKey() {
		oldKey := existing.VideoStorageKey.String
		if err := s.s3client.RemoveObject(ctx, s.s3cfg.Bucket, oldKey, minio.RemoveObjectOptions{}); err != nil {
			s.log.WarnContext(ctx, "lessons: failed to delete old video from storage",
				"old_key", oldKey, "err", err)
		}
	}

	return &richterv1.UpdateLessonVideoResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) DeleteLesson(
	ctx context.Context,
	req *richterv1.DeleteLessonRequest,
) (*richterv1.DeleteLessonResponse, error) {
	existing, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.fetch", err)...)
		return nil, err
	}
	module, err := s.fetchModule(ctx, existing.ModuleID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	// Collect chunk IDs before deletion for FDB cleanup.
	lessonIDStr := existing.ID.String()
	var chunkIDsToClean []string
	chunks, cerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
			LessonID: existing.ID,
			Limit:    int32(s.lessCfg.ListLimit),
			Offset:   0,
		})
	})
	if cerr == nil {
		for _, c := range chunks {
			chunkIDsToClean = append(chunkIDsToClean, c.ID.String())
		}
	}

	rowsAffected, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.DeleteLesson(ctx, existing.ID)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("lesson not found: %s", existing.ID))
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("DeleteLesson.NotFound", err)...)
		return nil, err
	}

	// Clean up the S3 video object after the PG row is gone. Best-effort.
	if existing.VideoStorageKey.Valid {
		if err := s.s3client.RemoveObject(ctx, s.s3cfg.Bucket, existing.VideoStorageKey.String, minio.RemoveObjectOptions{}); err != nil {
			s.log.WarnContext(ctx, "lessons: failed to delete lesson video from storage",
				"key", existing.VideoStorageKey.String, "err", err)
		}
	}

	// Clean up FDB data (best-effort; PG row already deleted).
	_ = s.kv.Delete(segment.NsLesson, tuple.Tuple{lessonIDStr, "transcript"})
	_ = s.kv.Delete(segment.NsLesson, tuple.Tuple{lessonIDStr, "segments"})
	for _, id := range chunkIDsToClean {
		_ = s.kv.Delete(segment.NsChunk, tuple.Tuple{id, "transcript"})
	}

	return &richterv1.DeleteLessonResponse{}, nil
}
