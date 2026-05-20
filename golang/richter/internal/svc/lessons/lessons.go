package lessons

import (
	"context"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewLessonsSvc),
)

func init() {
	Package(internal.Injector)
}

type LessonsSvc struct {
	pg       *db.PostgresSvc
	kv       *kv.KVSvc
	log      *log.LogSvc
	authz    *authz.AuthzSvc
	s3client *minio.Client
	s3cfg    *cfg.S3Cfg
}

var _ richterv1connect.LessonServiceHandler = (*LessonsSvc)(nil)

func NewLessonsSvc(i do.Injector) (s *LessonsSvc, err error) {
	s = new(LessonsSvc)
	s.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	s.kv, err = do.Invoke[*kv.KVSvc](i)
	if err != nil {
		return nil, fmt.Errorf("KVSvc cannot be invoked: %w", err)
	}
	s.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	s.authz, err = do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	s.s3cfg, err = do.Invoke[*cfg.S3Cfg](i)
	if err != nil {
		return nil, fmt.Errorf("S3Cfg cannot be invoked: %w", err)
	}
	s.s3client, err = minio.New(s.s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s.s3cfg.AccessKeyID, s.s3cfg.SecretAccessKey, ""),
		Secure: s.s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client init: %w", err)
	}
	return
}

func (s *LessonsSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewLessonServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

func (s *LessonsSvc) fetchModule(ctx context.Context, id string) (gen.CourseModule, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.CourseModule{}, err
	}
	m, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseModule, error) {
		return q.GetCourseModuleByID(ctx, uuid)
	})
	if err != nil {
		return gen.CourseModule{}, svc.ConnectDBError(err)
	}
	return m, nil
}

func (s *LessonsSvc) fetchCourse(ctx context.Context, id pgtype.UUID) (gen.Course, error) {
	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.GetCourseByID(ctx, id)
	})
	if err != nil {
		return gen.Course{}, svc.ConnectDBError(err)
	}
	return course, nil
}

func (s *LessonsSvc) fetchLesson(ctx context.Context, id string) (gen.Lesson, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.Lesson{}, err
	}
	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, uuid)
	})
	if err != nil {
		return gen.Lesson{}, svc.ConnectDBError(err)
	}
	return l, nil
}

func descToPgText(desc string) pgtype.Text {
	return pgtype.Text{String: desc, Valid: desc != ""}
}

func (s *LessonsSvc) CreateLesson(
	ctx context.Context,
	req *richterv1.CreateLessonRequest,
) (*richterv1.CreateLessonResponse, error) {
	module, err := s.fetchModule(ctx, req.GetModuleId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("CreateLesson.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("CreateLesson.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.CreateLesson(ctx, gen.CreateLessonParams{
			ModuleID:    module.ID,
			Title:       req.GetTitle(),
			Description: descToPgText(req.GetDescription()),
			OrderIndex:  req.GetOrderIndex(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("CreateLesson", err)...)
		return nil, err
	}
	return &richterv1.CreateLessonResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) GetLessonById(
	ctx context.Context,
	req *richterv1.GetLessonByIdRequest,
) (*richterv1.GetLessonByIdResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	l, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		if connect.CodeOf(err) == connect.CodeNotFound && claims.GetRole() != richterv1.UserRole_USER_ROLE_ADMIN {
			return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("not a member of this organization"))
		}
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("GetLessonById", err)...)
		return nil, err
	}
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, l.ID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}
	return &richterv1.GetLessonByIdResponse{Lesson: LessonToProto(l)}, nil
}

func (s *LessonsSvc) ListLessons(
	ctx context.Context,
	req *richterv1.ListLessonsRequest,
) (*richterv1.ListLessonsResponse, error) {
	moduleID, err := svc.ParseUUID(req.GetModuleId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessons.ParseUUID", err)...)
		return nil, err
	}

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByCourseModuleID(ctx, moduleID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	ls, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
		return q.ListLessons(ctx, gen.ListLessonsParams{
			ModuleID: moduleID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessons", err)...)
		return nil, err
	}

	out := make([]*richterv1.Lesson, 0, len(ls))
	for _, l := range ls {
		out = append(out, LessonToProto(l))
	}
	return &richterv1.ListLessonsResponse{Lessons: out}, nil
}

func (s *LessonsSvc) ListLessonsByCourse(
	ctx context.Context,
	req *richterv1.ListLessonsByCourseRequest,
) (*richterv1.ListLessonsByCourseResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse.ParseUUID", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, courseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgMember(ctx, course.OrganizationID); err != nil {
		return nil, err
	}

	ls, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
		return q.ListLessonsByCourse(ctx, gen.ListLessonsByCourseParams{
			CourseID: courseID,
			Limit:    req.GetLimit(),
			Offset:   req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("ListLessonsByCourse", err)...)
		return nil, err
	}

	out := make([]*richterv1.Lesson, 0, len(ls))
	for _, l := range ls {
		out = append(out, LessonToProto(l))
	}
	return &richterv1.ListLessonsByCourseResponse{Lessons: out}, nil
}

func (s *LessonsSvc) UpdateLesson(
	ctx context.Context,
	req *richterv1.UpdateLessonRequest,
) (*richterv1.UpdateLessonResponse, error) {
	existing, err := s.fetchLesson(ctx, req.GetId())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson.fetch", err)...)
		return nil, err
	}
	module, err := s.fetchModule(ctx, existing.ModuleID.String())
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson.fetchModule", err)...)
		return nil, err
	}
	course, err := s.fetchCourse(ctx, module.CourseID)
	if err != nil {
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson.fetchCourse", err)...)
		return nil, err
	}
	if _, err := s.authz.RequireOrgRole(ctx, course.OrganizationID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	lang := req.GetLanguage()
	if lang == "" {
		lang = existing.Language
	}
	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.UpdateLesson(ctx, gen.UpdateLessonParams{
			ID:          existing.ID,
			Title:       req.GetTitle(),
			Description: descToPgText(req.GetDescription()),
			OrderIndex:  req.GetOrderIndex(),
			Language:    lang,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		s.log.ErrorContext(ctx, "lessons service failed", svc.LogAttrs("UpdateLesson", err)...)
		return nil, err
	}
	return &richterv1.UpdateLessonResponse{Lesson: LessonToProto(l)}, nil
}

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

	// Collect chunk IDs before the transaction so we can clean up FDB after the PG delete.
	var chunkIDsToClean []string
	if existing.VideoStorageKey.Valid {
		chunks, cerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
			return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
				LessonID: existing.ID,
				Limit:    10000,
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
	l, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.Lesson, error) {
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
			if _, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
				LessonID: existing.ID, Status: gen.LessonAnalysisStatusPending, ErrorMsg: pgtype.Text{},
			}); err != nil {
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
		_ = s.kv.Delete("lesson", tuple.Tuple{lessonIDStr, "transcript"})
		_ = s.kv.Delete("lesson", tuple.Tuple{lessonIDStr, "segments"})
		for _, id := range chunkIDsToClean {
			_ = s.kv.Delete("chunk", tuple.Tuple{id, "transcript"})
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
			Limit:    10000,
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
	_ = s.kv.Delete("lesson", tuple.Tuple{lessonIDStr, "transcript"})
	_ = s.kv.Delete("lesson", tuple.Tuple{lessonIDStr, "segments"})
	for _, id := range chunkIDsToClean {
		_ = s.kv.Delete("chunk", tuple.Tuple{id, "transcript"})
	}

	return &richterv1.DeleteLessonResponse{}, nil
}

func (s *LessonsSvc) UpdateLessonFeedbackMode(
	ctx context.Context,
	req *richterv1.UpdateLessonFeedbackModeRequest,
) (*richterv1.UpdateLessonFeedbackModeResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetId())
	if err != nil {
		return nil, err
	}
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}
	updated, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.UpdateLessonFeedbackMode(ctx, gen.UpdateLessonFeedbackModeParams{
			ID:           lessonID,
			FeedbackMode: FeedbackModeFromProto(req.GetFeedbackMode()),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateLessonFeedbackModeResponse{Lesson: LessonToProto(updated)}, nil
}
