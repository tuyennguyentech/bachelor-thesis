package executors

import (
	"context"
	"fmt"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/svc/aitasks/svc"
	"example.com/richter/internal/taskqueue"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/samber/do/v2"
	"google.golang.org/protobuf/proto"
)

// PipelineRunExecutor runs the full AI pipeline in a single durable task:
// 1. Transcribe (extract transcript from video)
// 2. Chunk (segment the transcript)
// 3. QuizGen (generate interactions for all chunks)
//
// Progress steps are reported as top-level labels so the frontend can
// display a 3-stage strip: TRANSCRIBING → CHUNKING → GENERATING.
type PipelineRunExecutor struct {
	transcribe svc.TranscribeService
	chunk      svc.ChunkService
	quizGen    svc.QuizGenService
	tqDB       taskqueue.DB
}

func NewPipelineRunExecutor(injector do.Injector) *PipelineRunExecutor {
	return &PipelineRunExecutor{
		transcribe: do.MustInvoke[svc.TranscribeService](injector),
		chunk:      do.MustInvoke[svc.ChunkService](injector),
		quizGen:    do.MustInvoke[svc.QuizGenService](injector),
		tqDB:       do.MustInvoke[taskqueue.DB](injector),
	}
}

func (e *PipelineRunExecutor) Kind() string { return "pipeline_run" }

func (e *PipelineRunExecutor) Execute(ctx context.Context, env *taskqueue.Env) ([]byte, error) {
	var in richterv1.PipelineRunTaskInput
	if len(env.Input) > 0 {
		if err := proto.Unmarshal(env.Input, &in); err != nil {
			return nil, fmt.Errorf("pipeline_run: bad input: %w", err)
		}
	}

	lessonID, err := parseUUID(in.LessonId)
	if err != nil {
		return nil, err
	}

	taskUUID, err := uuid.Parse(env.TaskID)
	if err != nil {
		return nil, fmt.Errorf("pipeline_run: bad task id: %w", err)
	}
	taskIDpg := pgtype.UUID{Bytes: [16]byte(taskUUID), Valid: true}

	reportStage := func(step string, current, total int32, msg string) {
		_ = e.tqDB.UpdateTaskProgress(ctx, taskIDpg, step, current, total, msg)
	}

	// ── Stage 1: Transcribe ────────────────────────────────────────────────────
	env.Logger.Info("pipeline_run: stage TRANSCRIBING", "lesson_id", in.LessonId)
	reportStage("TRANSCRIBING", 1, 3, "Đang phiên âm video...")
	if err := e.transcribe.Run(ctx, lessonID, env); err != nil {
		return nil, fmt.Errorf("pipeline_run: transcribe stage: %w", err)
	}

	// ── Stage 2: Chunk ─────────────────────────────────────────────────────────
	env.Logger.Info("pipeline_run: stage CHUNKING", "lesson_id", in.LessonId)
	reportStage("CHUNKING", 2, 3, "Đang phân đoạn transcript...")
	if err := e.chunk.RunChunk(ctx, lessonID, env); err != nil {
		return nil, fmt.Errorf("pipeline_run: chunk stage: %w", err)
	}

	// ── Stage 3: Quiz generation ───────────────────────────────────────────────
	env.Logger.Info("pipeline_run: stage GENERATING", "lesson_id", in.LessonId)
	reportStage("GENERATING", 3, 3, "Đang tạo bài tập...")
	genReq := &richterv1.GenerateInteractionsRequest{
		LessonId:         in.LessonId,
		InteractionKinds: in.InteractionKinds,
		CountPerChunk:    in.CountPerChunk,
		Strategy:         in.Strategy,
		Difficulty:       in.Difficulty,
		FocusPrompt:      in.FocusPrompt,
		ForceRegenerate:  in.ForceRegenerate,
	}
	if err := e.quizGen.Run(ctx, lessonID, genReq, env); err != nil {
		return nil, fmt.Errorf("pipeline_run: quiz_gen stage: %w", err)
	}

	out := &richterv1.PipelineRunTaskOutput{CompletedAt: time.Now().Unix()}
	return proto.Marshal(out)
}

func init() {
	taskqueue.Register("pipeline_run", func() taskqueue.Executor {
		return NewPipelineRunExecutor(internal.Injector)
	})
}
