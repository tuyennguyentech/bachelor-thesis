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

// TranscribeExecutor runs the Whisper + segment pipeline.
type TranscribeExecutor struct {
	svc svc.TranscribeService
}

func NewTranscribeExecutor(injector do.Injector) *TranscribeExecutor {
	return &TranscribeExecutor{
		svc: do.MustInvoke[svc.TranscribeService](injector),
	}
}

func (e *TranscribeExecutor) Kind() string { return "transcribe" }

func (e *TranscribeExecutor) Execute(ctx context.Context, env *taskqueue.Env) ([]byte, error) {
	var in richterv1.TranscribeTaskInput
	if len(env.Input) > 0 {
		if err := proto.Unmarshal(env.Input, &in); err != nil {
			return nil, fmt.Errorf("transcribe: bad input: %w", err)
		}
	}
	lessonID, err := parseUUID(in.LessonId)
	if err != nil {
		return nil, err
	}
	if err := e.svc.Run(ctx, lessonID, env); err != nil {
		return nil, err
	}
	out := &richterv1.TranscribeTaskOutput{CompletedAt: time.Now().Unix()}
	return proto.Marshal(out)
}

func parseUUID(s string) (pgtype.UUID, error) {
	if s == "" {
		return pgtype.UUID{}, fmt.Errorf("empty uuid")
	}
	u, err := uuid.Parse(s)
	if err != nil {
		return pgtype.UUID{}, fmt.Errorf("parse uuid %q: %w", s, err)
	}
	return pgtype.UUID{Bytes: [16]byte(u), Valid: true}, nil
}

func init() {
	taskqueue.Register("transcribe", func() taskqueue.Executor {
		return NewTranscribeExecutor(internal.Injector)
	})
}
