package ai

import (
	"context"
	"errors"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/richter/internal/taskqueue"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// GetLessonAnalysis derives the analysis state from the tasks
// table. When no tasks exist for the lesson (e.g. seeded data that
// was created before the taskqueue cutover), it falls back to the
// legacy lesson_analyses table. Transcript text and segments still
// come from FDB. Chunks and interactions come from the existing
// per-lesson tables.
func (s *AISvc) GetLessonAnalysis(
	ctx context.Context,
	req *richterv1.GetLessonAnalysisRequest,
) (*richterv1.GetLessonAnalysisResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}

	if _, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID); err != nil {
		return nil, err
	}

	// Resolve org ID for the teacher-role check below.
	courseInfo, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.GetCourseAccessInfoByLessonIDRow, error) {
		return q.GetCourseAccessInfoByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	orgID := courseInfo.OrganizationID

	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	// Derive analysis status from the latest task per kind.
	latest, err := s.tqDB.ListLatestTaskPerLesson(ctx, []pgtype.UUID{lessonID})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	// Fallback: if no tasks exist for this lesson, read from
	// the legacy lesson_analyses table. This covers seeded data
	// that was created before the taskqueue cutover.
	var analysis gen.LessonAnalysis
	if len(latest) == 0 {
		analysis, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
			return q.GetLessonAnalysis(ctx, lessonID)
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// No analysis row — lesson hasn't been analyzed yet.
				// If a video is present, return a default PENDING analysis so
				// consumers know analysis is pending (or rather, ready to be started).
				if lesson.VideoStorageKey.Valid && lesson.VideoStorageKey.String != "" {
					analysis = gen.LessonAnalysis{
						LessonID: lessonID,
						Status:   gen.LessonAnalysisStatusPending,
					}
				} else {
					return &richterv1.GetLessonAnalysisResponse{}, nil
				}
			} else {
				return nil, svc.ConnectDBError(err)
			}
		}
	} else {
		analysis = deriveAnalysisFromTasks(lessonID, latest)
	}

	ints, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
			LessonID: lessonID,
			Limit:    s.interactionsLimit(),
			Offset:   0,
		})
	})
	if err != nil {
		s.log.ErrorContext(ctx, "ai: failed to list lesson interactions", svc.LogAttrs("ListLessonInteractions", err)...)
	}

	chunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: s.chunksLimit(), Offset: 0})
	})
	if err != nil {
		s.log.ErrorContext(ctx, "ai: failed to list lesson chunks", svc.LogAttrs("ListLessonTranscriptChunks", err)...)
	}
	normalizeGeneratedInteractionStartSeconds(ints, chunks)

	// Artifact-based floor: a lesson that already has generated interactions is
	// fully analyzed regardless of how its task rows look. Manual/per-chunk
	// generation creates NO quiz_gen task, and a stale or cancelled "latest" task
	// can otherwise leave the derived status at CHUNKS_READY/PENDING — which makes
	// the FE treat the lesson as unfinished, wipe its real chunks, and flip the
	// stepper between steps 3 and 4 across reloads. Only raise the status when no
	// stage is actively failing or in flight, so a genuine re-run still shows
	// progress/errors. Applies only to the task-derived path.
	if len(latest) > 0 {
		analysis.Status = applyArtifactFloor(time.Now(), analysis.Status, latest, len(chunks) > 0, len(ints) > 0)
	}

	lessonIDStr := lessonID.String()
	// Only load FDB transcript/segments when the transcribe step
	// has actually succeeded. For legacy data (no tasks), check
	// the analysis status directly.
	//
	// Also allow loading when chunk or quiz_gen succeeded — those
	// downstream stages imply transcribe was completed at some
	// point (e.g. seeded data may only have a quiz_gen task).
	canLoadTranscript := false
	if len(latest) > 0 {
		for _, t := range latest {
			if t.Status == string(taskqueue.StatusSucceeded) {
				canLoadTranscript = true
				break
			}
		}
	} else {
		// Legacy path: load FDB data when analysis status is
		// transcript_extracted or later.
		switch analysis.Status {
		case gen.LessonAnalysisStatusTranscriptExtracted,
			gen.LessonAnalysisStatusChunksReady,
			gen.LessonAnalysisStatusDone:
			canLoadTranscript = true
		}
	}
	var transcript string
	var segments []transcriptSegment
	if canLoadTranscript {
		transcript = s.loadTranscriptFromFDB(lessonIDStr)
		segments = s.loadSegmentsFromFDB(lessonIDStr)
	}

	protoChunks := make([]*richterv1.TranscriptChunk, 0, len(chunks))
	for _, c := range chunks {
		protoChunks = append(protoChunks, chunkToProto(c))
	}

	// Determine answer visibility: teachers always see answers; students only after submission.
	isTeacher := false
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err == nil {
		isTeacher = true
	}



	hasSubmitted := false
	if !isTeacher {
		if claims, _ := s.authz.RequireAuthenticated(ctx); claims != nil {
			if userID, perr := svc.ParseUUID(claims.GetSub()); perr == nil {
				if _, aerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
					return q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{LessonID: lessonID, UserID: userID})
				}); aerr == nil {
					hasSubmitted = true
				}
			}
		}
	}

	strip := svcinteractions.ShouldStripAnswers(lesson.FeedbackMode, isTeacher, hasSubmitted)
	return &richterv1.GetLessonAnalysisResponse{
		Analysis: analysisToProto(analysis, ints, strip, transcript, segments, interactionConfigFromJSON(lesson.DefaultInteractionConfig)),
		Chunks:   protoChunks,
	}, nil
}

// deriveAnalysisFromTasks returns a LessonAnalysis row equivalent
// derived from the latest task per kind. The proto consumers only
// need status (and the chunks/interactions are passed separately).
func deriveAnalysisFromTasks(lessonID pgtype.UUID, latest []taskqueue.Task) gen.LessonAnalysis {
	out := gen.LessonAnalysis{
		LessonID: lessonID,
		Status:   gen.LessonAnalysisStatusPending,
	}
	transcribeState := ""
	chunkState := ""
	for _, t := range latest {
		switch t.TaskType {
		case "transcribe":
			transcribeState = t.Status
		case "chunk":
			chunkState = t.Status
		}
	}
	switch {
	case chunkState == string(taskqueue.StatusSucceeded):
		out.Status = gen.LessonAnalysisStatusChunksReady
	case transcribeState == string(taskqueue.StatusSucceeded):
		out.Status = gen.LessonAnalysisStatusTranscriptExtracted
	case transcribeState == string(taskqueue.StatusProcessing) || chunkState == string(taskqueue.StatusProcessing):
		out.Status = gen.LessonAnalysisStatusPending
	case transcribeState == string(taskqueue.StatusFailed) || chunkState == string(taskqueue.StatusFailed):
		out.Status = gen.LessonAnalysisStatusError
	}
	// Any successfully completed quiz_gen task means the lesson is
	// fully analyzed — but only if no upstream stage has failed.
	// A stale quiz_gen from a previous run must not mask a failed
	// re-run of chunk or transcribe.
	hasSucceededInteractions := false
	hasFailedUpstream := transcribeState == string(taskqueue.StatusFailed) ||
		chunkState == string(taskqueue.StatusFailed)
	for _, t := range latest {
		if t.TaskType == "quiz_gen" && t.Status == string(taskqueue.StatusSucceeded) {
			hasSucceededInteractions = true
			break
		}
	}
	if hasSucceededInteractions && !hasFailedUpstream {
		out.Status = gen.LessonAnalysisStatusDone
	}

	// pipeline_run is the COMPOSITE Quick-Create task: it runs transcribe → chunk
	// → quiz_gen inside a SINGLE durable task and does NOT create separate
	// transcribe/chunk/quiz_gen task rows. So for a Quick-Create lesson the
	// per-stage logic above never fires and the status would stay at the PENDING
	// default — which makes the FE treat the lesson as a brand-new upload and WIPE
	// the freshly-generated chunks/interactions (the "stuck at Phiên âm on reload"
	// bug). Derive the status from the pipeline task itself instead:
	//   succeeded  → DONE (fully analyzed)
	//   in flight  → PROCESSING (NOT pending: keeps the generated data on screen)
	//   failed     → ERROR
	pipelineState := ""
	for _, t := range latest {
		if t.TaskType == "pipeline_run" {
			pipelineState = t.Status
		}
	}
	switch pipelineState {
	case string(taskqueue.StatusSucceeded):
		if !hasFailedUpstream {
			out.Status = gen.LessonAnalysisStatusDone
		}
	case string(taskqueue.StatusProcessing), string(taskqueue.StatusInqueued), string(taskqueue.StatusPending):
		if out.Status == gen.LessonAnalysisStatusPending {
			out.Status = gen.LessonAnalysisStatusProcessing
		}
	case string(taskqueue.StatusFailed):
		if out.Status == gen.LessonAnalysisStatusPending {
			out.Status = gen.LessonAnalysisStatusError
		}
	}
	return out
}

// processingStaleAfter: a "processing" task whose heartbeat is older than this is
// treated as a dead worker. Set comfortably above the reaper's stale threshold so
// the floor only intervenes for genuinely orphaned tasks, never during a normal
// heartbeat gap of a live worker.
const processingStaleAfter = 90 * time.Second

// applyArtifactFloor raises a task-derived analysis status to reflect artifacts
// that actually exist in the DB (chunks / interactions), which the per-task
// derivation can miss (per-chunk/manual generation creates no quiz_gen task; a
// cancelled or tied "latest" row can understate progress). It NEVER lowers the
// status, and it does not override an active failure or in-flight re-run — so a
// genuine reprocess still surfaces progress/errors rather than snapping to DONE.
func applyArtifactFloor(now time.Time, status gen.LessonAnalysisStatus, latest []taskqueue.Task, hasChunks, hasInteractions bool) gen.LessonAnalysisStatus {
	for _, t := range latest {
		switch t.Status {
		case string(taskqueue.StatusFailed),
			string(taskqueue.StatusInqueued),
			string(taskqueue.StatusPending):
			// Failing or queued to (re)run — keep the derived status so the FE
			// shows the error / in-flight progress, not a stale DONE.
			return status
		case string(taskqueue.StatusProcessing):
			// A processing task with a FRESH heartbeat is genuinely running, so
			// keep the in-flight status. But a STALE heartbeat means the worker
			// died mid-task (e.g. a crash): the reaper will requeue it, and
			// meanwhile the artifacts that DO exist are the truth — a dead task
			// must not pin the UI in "processing" forever.
			if t.Heartbeat.Valid && now.Sub(t.Heartbeat.Time) < processingStaleAfter {
				return status
			}
		}
	}
	if hasInteractions {
		return gen.LessonAnalysisStatusDone
	}
	if hasChunks &&
		(status == gen.LessonAnalysisStatusPending ||
			status == gen.LessonAnalysisStatusTranscriptExtracted) {
		return gen.LessonAnalysisStatusChunksReady
	}
	return status
}
