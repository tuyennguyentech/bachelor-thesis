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

// ChunkExecutor runs the Gemini chunking pipeline.
type ChunkExecutor struct {
	svc svc.ChunkService
}

func NewChunkExecutor(injector do.Injector) *ChunkExecutor {
	return &ChunkExecutor{
		svc: do.MustInvoke[svc.ChunkService](injector),
	}
}

func (e *ChunkExecutor) Kind() string { return "chunk" }

func (e *ChunkExecutor) Execute(ctx context.Context, env *taskqueue.Env) ([]byte, error) {
	var in richterv1.ChunkTaskInput
	if len(env.Input) > 0 {
		if err := proto.Unmarshal(env.Input, &in); err != nil {
			return nil, fmt.Errorf("chunk: bad input: %w", err)
		}
	}
	lessonID, err := parseUUID(in.LessonId)
	if err != nil {
		return nil, err
	}
	if err := e.svc.RunChunk(ctx, lessonID, env); err != nil {
		return nil, err
	}
	out := &richterv1.ChunkTaskOutput{CompletedAt: time.Now().Unix()}
	return proto.Marshal(out)
}

func init() {
	taskqueue.Register("chunk", func() taskqueue.Executor {
		return NewChunkExecutor(internal.Injector)
	})
}
