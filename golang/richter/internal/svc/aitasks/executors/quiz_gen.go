package executors

import (
	"context"
	"fmt"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/svc/aitasks/svc"
	"example.com/richter/internal/taskqueue"
	"github.com/samber/do/v2"
	"google.golang.org/protobuf/proto"
)

// QuizGenExecutor runs the interaction-generation pipeline.
type QuizGenExecutor struct {
	svc svc.QuizGenService
}

func NewQuizGenExecutor(injector do.Injector) *QuizGenExecutor {
	return &QuizGenExecutor{
		svc: do.MustInvoke[svc.QuizGenService](injector),
	}
}

func (e *QuizGenExecutor) Kind() string { return "quiz_gen" }

func (e *QuizGenExecutor) Execute(ctx context.Context, env *taskqueue.Env) ([]byte, error) {
	var in richterv1.QuizGenTaskInput
	if len(env.Input) > 0 {
		if err := proto.Unmarshal(env.Input, &in); err != nil {
			return nil, fmt.Errorf("quiz_gen: bad input: %w", err)
		}
	}
	lessonID, err := parseUUID(in.LessonId)
	if err != nil {
		return nil, err
	}
	req := &richterv1.GenerateInteractionsRequest{
		LessonId:        in.LessonId,
		ChunkId:         in.ChunkId,
		ForceRegenerate: in.ForceRegenerate,
		InteractionKinds: in.InteractionKinds,
		CountPerChunk:   in.CountPerChunk,
		Strategy:        in.Strategy,
		Difficulty:      in.Difficulty,
		FocusPrompt:     in.FocusPrompt,
	}
	if err := e.svc.Run(ctx, lessonID, req, env); err != nil {
		return nil, err
	}
	out := &richterv1.QuizGenTaskOutput{CompletedAt: time.Now().Unix()}
	return proto.Marshal(out)
}

func init() {
	taskqueue.Register("quiz_gen", func() taskqueue.Executor {
		return NewQuizGenExecutor(internal.Injector)
	})
}
