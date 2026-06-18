package ai

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
	"example.com/richter/internal/svc/ai/chunkops"
	"example.com/richter/internal/svc/ai/genengine"
	"example.com/richter/internal/svc/ai/generation"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/richter/internal/svc/ai/transcript"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/richter/internal/taskqueue"
	"example.com/richter/log"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

// transcriptSegment is a backwards-compatible alias for segment.Segment.
// Existing code in this package (and its companions) keeps using the
// short name; new code should prefer segment.Segment directly.
type transcriptSegment = segment.Segment

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
	// Wire the new taskqueue system.
	do.Lazy(taskqueue.NewDB),
	do.Lazy(taskqueue.NewScanner),
	do.Lazy(taskqueue.NewListenerFromDI),
	do.Lazy(taskqueue.NewWorker),
)

func init() {
	Package(internal.Injector)
}

type AISvc struct {
	pg            *db.PostgresSvc
	kv            *kv.KVSvc
	log           *log.LogSvc
	authz         *authz.AuthzSvc
	s3client      *minio.Client
	s3cfg         *cfg.S3Cfg
	geminiCfg     *cfg.GeminiCfg
	sttCfg        *cfg.STTCfg
	aiCfg         *cfg.AiCfg
	apiCfg        *cfg.ApiCfg
	taskCfg       *cfg.LessonTaskCfg
	ttsCfg        *cfg.TTSCfg
	ttsClient     TTSSynthesizer
	chunking      *chunkingService
	chunkOps      *chunkops.Service
	transcription *transcriptionService
	grading       *gradingService
	generation    *generation.Service
	transcript    *transcript.Service
	tqDB          taskqueue.DB
}

// FDB namespace constants.
const (
	kvNsWatch = "watch"
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
	sttCfg, err := do.Invoke[*cfg.STTCfg](i)
	if err != nil {
		return nil, fmt.Errorf("STTCfg: %w", err)
	}
	aiCfg, err := do.Invoke[*cfg.AiCfg](i)
	if err != nil {
		return nil, fmt.Errorf("AiCfg: %w", err)
	}
	taskCfg, err := do.Invoke[*cfg.LessonTaskCfg](i)
	if err != nil {
		return nil, fmt.Errorf("LessonTaskCfg: %w", err)
	}
	ttsCfg, err := do.Invoke[*cfg.TTSCfg](i)
	if err != nil {
		return nil, fmt.Errorf("TTSCfg: %w", err)
	}
	tqDB, err := do.Invoke[taskqueue.DB](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.DB: %w", err)
	}

	apiCfg, err := do.Invoke[*cfg.ApiCfg](i)
	if err != nil {
		return nil, fmt.Errorf("ApiCfg: %w", err)
	}

	s3client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client: %w", err)
	}

	// The LLM engine behind chunking + item generation. Selected by
	// geminiCfg.Engine ("gemini" → real API, "mock" → canned responses for tests).
	genEngine := genengine.New(geminiCfg)
	l.Info("ai: generation engine selected", "engine", genEngine.Name())

	transcription := newTranscriptionService(s3client, s3cfg, sttCfg, aiCfg)
	svc := &AISvc{
		pg: pg, kv: kvSvc, log: l, authz: az,
		s3client: s3client, s3cfg: s3cfg, geminiCfg: geminiCfg, sttCfg: sttCfg, aiCfg: aiCfg,
		apiCfg:  apiCfg,
		taskCfg: taskCfg,
		ttsCfg:  ttsCfg, ttsClient: newSpeachesTTSClient(ttsCfg, aiCfg.TTSMaxConcurrent, aiCfg.TTSRequestTimeout),
		chunking:      newChunkingService(aiCfg, genEngine, l),
		transcription: transcription,
		grading:       newGradingService(geminiCfg, transcription),
		tqDB:          tqDB,
	}
	svc.generation = generation.New(generation.Deps{
		Postgres:             pg,
		Log:                  l,
		AiCfg:                aiCfg,
		Engine:               genEngine,
		FetchChunkTranscript: func(chunkID string) string { return segment.FetchChunkTranscript(kvSvc, chunkID) },
		EmbedAudio:           svc.synthesiseAndEmbed,
		ChunksLimit:          svc.chunksLimit,
		InteractionsLimit:    svc.interactionsLimit,
	})
	svc.chunkOps = chunkops.New(chunkops.Deps{
		Postgres:             pg,
		KV:                   kvSvc,
		Log:                  l,
		RequireTeacherRole:   svc.requireTeacherRole,
		LoadSegments:         func(lessonID string) []segment.Segment { return segment.LoadSegments(kvSvc, lessonID) },
		FetchChunkTranscript: func(chunkID string) string { return segment.FetchChunkTranscript(kvSvc, chunkID) },
		ChunksLimit:          svc.chunksLimit,
	})
	svc.transcript = transcript.New(transcript.Deps{
		Postgres: pg,
		KV:       kvSvc,
		Log:      l,
		Transcription: func(ctx context.Context, videoKey string, audioLang string, progress transcript.ProgressFn) (string, []transcriptSegment, error) {
			// STTRunner expects transcript.ProgressFn;
			// runSTTAnalyze uses the local progressFn alias
			// (which is task.ProgressFn). Bridge with a wrapper
			// that has the right type for the call site.
			adapted := func(step richterv1.AnalysisProgressStep, msg string) error {
				return progress(step, msg)
			}
			return transcription.runSTTAnalyze(ctx, videoKey, audioLang, adapted)
		},
		Chunk: func(ctx context.Context, t string, segs []byte, language string) ([]transcript.ChunkProposal, error) {
			raws, err := svc.chunking.runGeminiChunk(ctx, t, segs, language)
			if err != nil {
				return nil, err
			}
			out := make([]transcript.ChunkProposal, len(raws))
			for i, r := range raws {
				out[i] = transcript.ChunkProposal{
					StartSeconds: r.StartSeconds,
					EndSeconds:   r.EndSeconds,
					Summary:      r.Summary,
				}
			}
			return out, nil
		},
		Locks:               analysisLocks,
		ChunksLimit:         svc.chunksLimit,
		LessonOpsLimit:      svc.lessonOpsLimit,
		RequireTeacherRole:  svc.requireTeacherRole,
		RequireOrgMember:    az,
		PersistExtractError: svc.persistExtractError,
	})

	// Wire the new taskqueue components: listener + scanner +
	// worker. The executors (transcribe/chunk/quiz_gen/composite)
	// are registered via init() in the aitasks/executors package,
	// which is imported transitively.
	scanner, err := do.Invoke[*taskqueue.Scanner](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.Scanner: %w", err)
	}
	listener, err := do.Invoke[*taskqueue.Listener](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.Listener: %w", err)
	}
	worker, err := do.Invoke[*taskqueue.Worker](i)
	if err != nil {
		return nil, fmt.Errorf("taskqueue.Worker: %w", err)
	}
	// Start them in the background. Each runs until the service is
	// stopped. We don't block here. Background context since these
	// run for the process lifetime.
	ctx := context.Background()
	go scanner.Run(ctx)
	go listener.Run(ctx)
	go worker.Run(ctx)
	return svc, nil
}

// ensure interface compliance at compile time
var _ interface {
	Handler() (string, http.Handler)
} = (*AISvc)(nil)

// Transcript returns the transcript sub-service. Exposed for the
// aitasks/svc shims so they can invoke the existing pipeline
// without importing the sub-package directly.
func (s *AISvc) Transcript() *transcript.Service { return s.transcript }

// Generation returns the interaction-generation sub-service.
// Same rationale as Transcript().
func (s *AISvc) Generation() *generation.Service { return s.generation }

func (s *AISvc) Handler() (string, http.Handler) {
	return richterv1connect.NewAIServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}
