package ai

import (
	"context"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/richter/log"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewAISvc),
	// Provide AIRegenerateFunc so InteractionsSvc can regenerate single interactions
	// without creating a circular import (ai ↔ interactions).
	do.Lazy[svcinteractions.AIRegenerateFunc](func(i do.Injector) (svcinteractions.AIRegenerateFunc, error) {
		ai, err := do.Invoke[*AISvc](i)
		if err != nil {
			return nil, err
		}
		return ai.doRegenerateInteraction, nil
	}),
	// Provide GradingDepsProvider so InteractionsSvc can grade audio-based responses.
	do.Lazy[svcinteractions.GradingDepsProvider](func(i do.Injector) (svcinteractions.GradingDepsProvider, error) {
		ai, err := do.Invoke[*AISvc](i)
		if err != nil {
			return nil, err
		}
		return ai.buildGradingDeps, nil
	}),
	// Provide AudioObjectDeleter so InteractionsSvc can clean up old student recordings.
	do.Lazy[svcinteractions.AudioObjectDeleter](func(i do.Injector) (svcinteractions.AudioObjectDeleter, error) {
		ai, err := do.Invoke[*AISvc](i)
		if err != nil {
			return nil, err
		}
		return func(ctx context.Context, objectKey string) error {
			return ai.s3client.RemoveObject(ctx, ai.s3cfg.Bucket, objectKey, minio.RemoveObjectOptions{})
		}, nil
	}),
)

func init() {
	Package(internal.Injector)
}

type AISvc struct {
	pg             *db.PostgresSvc
	kv             *kv.KVSvc
	log            *log.LogSvc
	authz          *authz.AuthzSvc
	s3client       *minio.Client
	s3cfg          *cfg.S3Cfg
	geminiCfg      *cfg.GeminiCfg
	whisperCfg     *cfg.WhisperCfg
	ttsCfg         *cfg.TTSCfg
	ttsClient      *PiperTTSClient
	chunking       *chunkingService
	transcription  *transcriptionService
	grading        *gradingService
	interactionGen *interactionGenerationService
}

// FDB namespace constants.
const (
	kvNsLesson = "lesson"
	kvNsChunk  = "chunk"
	kvNsWatch  = "watch"
)

var _ richterv1connect.AIServiceHandler = (*AISvc)(nil)

func NewAISvc(i do.Injector) (*AISvc, error) {
	pg, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc: %w", err)
	}
	kvSvc, err := do.Invoke[*kv.KVSvc](i)
	if err != nil {
		return nil, fmt.Errorf("KVSvc: %w", err)
	}
	l, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc: %w", err)
	}
	az, err := do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc: %w", err)
	}
	s3cfg, err := do.Invoke[*cfg.S3Cfg](i)
	if err != nil {
		return nil, fmt.Errorf("S3Cfg: %w", err)
	}
	geminiCfg, err := do.Invoke[*cfg.GeminiCfg](i)
	if err != nil {
		return nil, fmt.Errorf("GeminiCfg: %w", err)
	}
	whisperCfg, err := do.Invoke[*cfg.WhisperCfg](i)
	if err != nil {
		return nil, fmt.Errorf("WhisperCfg: %w", err)
	}
	ttsCfg, err := do.Invoke[*cfg.TTSCfg](i)
	if err != nil {
		return nil, fmt.Errorf("TTSCfg: %w", err)
	}

	s3client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}

	transcription := newTranscriptionService(s3client, s3cfg, whisperCfg)
	svc := &AISvc{
		pg: pg, kv: kvSvc, log: l, authz: az,
		s3client: s3client, s3cfg: s3cfg, geminiCfg: geminiCfg, whisperCfg: whisperCfg,
		ttsCfg: ttsCfg, ttsClient: newPiperTTSClient(ttsCfg.Endpoint),
		chunking:      newChunkingService(geminiCfg, l),
		transcription: transcription,
		grading:       newGradingService(geminiCfg, transcription),
	}
	svc.interactionGen = newInteractionGenerationService(geminiCfg, l, svc.synthesiseAndEmbed)
	return svc, nil
}

func (s *AISvc) Handler() (string, http.Handler) {
	return richterv1connect.NewAIServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}
