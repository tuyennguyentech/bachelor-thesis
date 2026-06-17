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

// shouldForceGen decides whether the quiz-generation stage runs with
// ForceRegenerate. quiz_gen skips chunks that already have interactions UNLESS
// forcing. On a FRESH run the chunk stage just rebuilt all chunks (wiping
// interactions), so force is moot. On a RESUME that SKIPPED the chunk stage
// (doneStage >= CHUNKED), some chunks already have interactions — forcing there
// would DUPLICATE them. So only honour ForceRegenerate when the chunk stage
// actually (re)ran this run.
func shouldForceGen(forceRegenerate bool, doneStage richterv1.PipelineStage) bool {
	return forceRegenerate && doneStage < richterv1.PipelineStage_PIPELINE_STAGE_CHUNKED
}

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

	// Worker UUID for ownership-guarded checkpoint writes (no-op if a steal
	// happened, mirroring the terminal-write guard).
	var workerIDpg pgtype.UUID
	if wu, werr := uuid.Parse(env.WorkerID); werr == nil {
		workerIDpg = pgtype.UUID{Bytes: [16]byte(wu), Valid: true}
	}

	// Resume point: the highest stage completed by a previous (crashed) run,
	// recovered from the task's checkpointed output_payload.
	doneStage := richterv1.PipelineStage_PIPELINE_STAGE_UNSPECIFIED
	if len(env.PriorOutput) > 0 {
		var prev richterv1.PipelineRunTaskOutput
		if proto.Unmarshal(env.PriorOutput, &prev) == nil {
			doneStage = prev.Stage
		}
	}

	out := &richterv1.PipelineRunTaskOutput{Stage: doneStage}
	saveCheckpoint := func(stage richterv1.PipelineStage) {
		out.Stage = stage
		if b, merr := proto.Marshal(out); merr == nil {
			_ = e.tqDB.SetTaskCheckpoint(ctx, taskIDpg, b, workerIDpg)
		}
	}
	reportStage := func(step string, current, total int32, msg string) {
		_ = e.tqDB.UpdateTaskProgress(ctx, taskIDpg, step, current, total, msg)
	}

	// ── Stage 1: Transcribe ────────────────────────────────────────────────────
	// transcribe/chunk are destructive-rebuild (re-running wipes downstream), so
	// once a stage's checkpoint is persisted we must NOT re-enter it on resume.
	if doneStage < richterv1.PipelineStage_PIPELINE_STAGE_TRANSCRIBED {
		env.Logger.Info("pipeline_run: stage TRANSCRIBING", "lesson_id", in.LessonId)
		env.StageLabel = "TRANSCRIBING"
		reportStage("TRANSCRIBING", 1, 3, "Đang phiên âm video...")
		if err := e.transcribe.Run(ctx, lessonID, env); err != nil {
			return nil, fmt.Errorf("pipeline_run: transcribe stage: %w", err)
		}
		saveCheckpoint(richterv1.PipelineStage_PIPELINE_STAGE_TRANSCRIBED)
	} else {
		env.Logger.Info("pipeline_run: resume — skip TRANSCRIBING", "lesson_id", in.LessonId)
	}

	// ── Stage 2: Chunk ─────────────────────────────────────────────────────────
	if doneStage < richterv1.PipelineStage_PIPELINE_STAGE_CHUNKED {
		env.Logger.Info("pipeline_run: stage CHUNKING", "lesson_id", in.LessonId)
		env.StageLabel = "CHUNKING"
		reportStage("CHUNKING", 2, 3, "Đang phân đoạn transcript...")
		if err := e.chunk.RunChunk(ctx, lessonID, env); err != nil {
			return nil, fmt.Errorf("pipeline_run: chunk stage: %w", err)
		}
		saveCheckpoint(richterv1.PipelineStage_PIPELINE_STAGE_CHUNKED)
	} else {
		env.Logger.Info("pipeline_run: resume — skip CHUNKING", "lesson_id", in.LessonId)
	}

	// ── Stage 3: Quiz generation ───────────────────────────────────────────────
	genForce := shouldForceGen(in.ForceRegenerate, doneStage)
	env.Logger.Info("pipeline_run: stage GENERATING", "lesson_id", in.LessonId, "force", genForce)
	env.StageLabel = "GENERATING"
	reportStage("GENERATING", 3, 3, "Đang tạo bài tập...")
	genReq := &richterv1.GenerateInteractionsRequest{
		LessonId:         in.LessonId,
		InteractionKinds: in.InteractionKinds,
		CountPerChunk:    in.CountPerChunk,
		Strategy:         in.Strategy,
		Difficulty:       in.Difficulty,
		FocusPrompt:      in.FocusPrompt,
		ForceRegenerate:  genForce,
	}
	if err := e.quizGen.Run(ctx, lessonID, genReq, env); err != nil {
		return nil, fmt.Errorf("pipeline_run: quiz_gen stage: %w", err)
	}

	out.Stage = richterv1.PipelineStage_PIPELINE_STAGE_GENERATED
	out.CompletedAt = time.Now().Unix()
	return proto.Marshal(out)
}

func init() {
	taskqueue.Register("pipeline_run", func() taskqueue.Executor {
		return NewPipelineRunExecutor(internal.Injector)
	})
}
