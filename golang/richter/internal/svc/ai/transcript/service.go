// Package transcript owns the lesson-level transcript pipeline: extract
// audio → STT transcription, segment editing, chunk pipeline, and the
// thin CRUD read/update methods exposed to the dashboard. The HTTP handler
// methods on *ai.AISvc are thin pass-throughs into this package.
package transcript

import (
	"context"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/richter/log"
	"github.com/jackc/pgx/v5/pgtype"
)

// ProgressFn is the callback the audio pipeline invokes to report progress
// to the task worker. Returning a non-nil error aborts the pipeline.
type ProgressFn func(step richterv1.AnalysisProgressStep, msg string) error

// STTRunner is the audio → transcript pipeline. The ai package wires
// transcriptionService.runSTTAnalyze here. Keeping it as a function
// type (rather than an interface on the concrete type) lets this package
// stay decoupled from the ai package's internals.
type STTRunner func(ctx context.Context, videoKey string, audioLang string, progress ProgressFn) (string, []segment.Segment, error)

// LessonLock is the handle returned by TryAcquireLessonLock. Callers must
// pass it to ReleaseLessonLock when done. Stored as `any` so this package
// doesn't depend on the in-process lock implementation in package ai.
type LessonLock = any

// LessonLocker grants per-lesson mutexes. *ai.analysisLocks satisfies this.
type LessonLocker interface {
	TryAcquire(lessonIDStr string) (LessonLock, bool)
	Release(lessonIDStr string, lock LessonLock)
}

// Deps is the bundle of services a Service needs. The ai package constructs
// one of these from its own fields; Service holds it by value so we don't
// grow an interface just to swap implementations.
type Deps struct {
	Postgres *db.PostgresSvc
	KV       *kv.KVSvc
	Log      *log.LogSvc

	Transcription STTRunner
	Chunk         ChunkRunner
	Locks         LessonLocker

	// List-page size helpers (configurable via [ai] section).
	ChunksLimit    func() int32
	LessonOpsLimit func() int32

	// Auth: must return connect.CodePermissionDenied for non-teachers.
	RequireTeacherRole func(ctx context.Context, lessonID pgtype.UUID) error
	RequireOrgMember   *authz.AuthzSvc

	// Best-effort error persistence: store error_msg on the lesson
	// analysis row so the dashboard can show it.
	PersistExtractError func(ctx context.Context, lessonID pgtype.UUID, msg string) bool
}

// Service is the transcript pipeline. Construct with New and call the
// HTTP-handler methods (List, UpdateSegment, UpdateConfig) or worker
// helpers (RunExtract, RunChunk) directly.
type Service struct {
	Deps
}

// New constructs a Service. The caller (typically *ai.AISvc.NewAISvc) is
// responsible for wiring the Deps fields.
func New(d Deps) *Service {
	return &Service{Deps: d}
}
