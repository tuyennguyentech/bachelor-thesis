package svc

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai"
	"example.com/richter/internal/svc/ai/generation"
	"example.com/richter/internal/svc/ai/transcript"
	"example.com/richter/internal/taskqueue"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

// TranscribeService wraps transcript.Service.
type TranscribeService interface {
	Run(ctx context.Context, lessonID pgtype.UUID, env *taskqueue.Env) error
}

// ChunkService wraps transcript.Service for chunking.
type ChunkService interface {
	RunChunk(ctx context.Context, lessonID pgtype.UUID, env *taskqueue.Env) error
}

// QuizGenService wraps generation.Service.
type QuizGenService interface {
	Run(ctx context.Context, lessonID pgtype.UUID, req *richterv1.GenerateInteractionsRequest, env *taskqueue.Env) error
}

var Package = do.Package(
	do.Lazy(NewTranscribeService),
	do.Lazy(NewChunkService),
	do.Lazy(NewQuizGenService),
)

func init() { Package(internal.Injector) }

func invokeAISvc(i do.Injector) (*ai.AISvc, error) {
	return do.Invoke[*ai.AISvc](i)
}

// ─── Concrete implementations ──────────────────────────────────────────────

type transcriptSvcImpl struct {
	svc  *transcript.Service
	tqDB taskqueue.DB
}

func (s *transcriptSvcImpl) Run(ctx context.Context, lessonID pgtype.UUID, env *taskqueue.Env) error {
	taskUUID, err := uuid.Parse(env.TaskID)
	if err != nil {
		return err
	}
	taskIDpg := pgtype.UUID{Bytes: [16]byte(taskUUID), Valid: true}

	prog := func(step richterv1.AnalysisProgressStep, msg string) error {
		_ = s.tqDB.UpdateTaskProgress(ctx, taskIDpg, step.String(), 0, 0, msg)
		return nil
	}

	var videoKey string
	err = db.WithConnectionExec(s.svc.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		lesson, err := q.GetLessonByID(ctx, lessonID)
		if err != nil {
			return err
		}
		if lesson.VideoStorageKey.Valid {
			videoKey = lesson.VideoStorageKey.String
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("load lesson video key: %w", err)
	}
	if videoKey == "" {
		return fmt.Errorf("lesson has no video uploaded")
	}

	return s.svc.RunExtract(ctx, lessonID, videoKey, prog)
}

func (s *transcriptSvcImpl) RunChunk(ctx context.Context, lessonID pgtype.UUID, env *taskqueue.Env) error {
	taskUUID, err := uuid.Parse(env.TaskID)
	if err != nil {
		return err
	}
	taskIDpg := pgtype.UUID{Bytes: [16]byte(taskUUID), Valid: true}

	prog := func(step richterv1.AnalysisProgressStep, msg string) error {
		_ = s.tqDB.UpdateTaskProgress(ctx, taskIDpg, step.String(), 0, 0, msg)
		return nil
	}
	return s.svc.RunChunk(ctx, lessonID, prog)
}

type generationSvcImpl struct {
	svc  *generation.Service
	tqDB taskqueue.DB
}

func (s *generationSvcImpl) Run(ctx context.Context, lessonID pgtype.UUID, req *richterv1.GenerateInteractionsRequest, env *taskqueue.Env) error {
	taskUUID, err := uuid.Parse(env.TaskID)
	if err != nil {
		return err
	}
	taskIDpg := pgtype.UUID{Bytes: [16]byte(taskUUID), Valid: true}

	send := func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error {
		_ = s.tqDB.UpdateTaskProgress(ctx, taskIDpg, step.String(), chunkIndex, totalChunks, msg)
		return nil
	}
	return s.svc.Run(ctx, lessonID, req, send)
}

// ─── DI providers ──────────────────────────────────────────────────────────

func NewTranscribeService(injector do.Injector) (TranscribeService, error) {
	aiSvc, err := invokeAISvc(injector)
	if err != nil {
		return nil, err
	}
	tqDB, err := do.Invoke[taskqueue.DB](injector)
	if err != nil {
		return nil, err
	}
	return &transcriptSvcImpl{svc: aiSvc.Transcript(), tqDB: tqDB}, nil
}

func NewChunkService(injector do.Injector) (ChunkService, error) {
	aiSvc, err := invokeAISvc(injector)
	if err != nil {
		return nil, err
	}
	tqDB, err := do.Invoke[taskqueue.DB](injector)
	if err != nil {
		return nil, err
	}
	return &transcriptSvcImpl{svc: aiSvc.Transcript(), tqDB: tqDB}, nil
}

func NewQuizGenService(injector do.Injector) (QuizGenService, error) {
	aiSvc, err := invokeAISvc(injector)
	if err != nil {
		return nil, err
	}
	tqDB, err := do.Invoke[taskqueue.DB](injector)
	if err != nil {
		return nil, err
	}
	return &generationSvcImpl{svc: aiSvc.Generation(), tqDB: tqDB}, nil
}
