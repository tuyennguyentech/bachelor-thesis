package ai

import (
	"bytes"
	"context"
	"errors"
	"strings"
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

	// Consistency projection: the response must never expose artifacts that
	// contradict the derived status. When the latest transcript-producing task
	// FAILED, the transcript was destroyed at the start of that run (RunExtract
	// wipes transcript+segments+chunks+interactions up front), so any chunk /
	// interaction rows still in the DB are stale garbage from a previous run —
	// e.g. rows left behind by an older binary that only cleaned up on success
	// (the reported bug: a locked "Phân đoạn" step still showing "4 đoạn" and a
	// phantom failed-generation banner after a failed re-transcribe). Suppress
	// them from the RESPONSE only — applyArtifactFloor above already consumed
	// the RAW artifact truth, so status derivation is unaffected. NOTE: keyed on
	// the failed STAGE, not on status==ERROR — a pipeline that failed at the
	// GENERATING stage has perfectly valid chunks and must keep showing them.
	// The len(latest)==0 arm covers the legacy no-tasks fallback: a pre-cutover
	// lesson_analyses row stuck at ERROR has no valid transcript either, so its
	// artifact rows are equally stale.
	if transcriptInvalidated(latest) ||
		(len(latest) == 0 && analysis.Status == gen.LessonAnalysisStatusError) {
		chunks = nil
		ints = nil
	}

	lessonIDStr := lessonID.String()
	// Load the transcript + segments from FDB only when the derived status says a
	// transcript genuinely exists for the CURRENT video. The set INCLUDES
	// PROCESSING — a Quick-Create RUN_PIPELINE in flight whose transcribe stage has
	// already saved segments (the case the old "only when a task SUCCEEDED" gate
	// wrongly hid: the pipeline_run stays PROCESSING, so segments never showed —
	// Image #3). It EXCLUDES PENDING (e.g. the video was just replaced and stale
	// data still sits in FDB) and ERROR, so those never surface a stale transcript.
	var transcript string
	var segments []transcriptSegment
	switch analysis.Status {
	case gen.LessonAnalysisStatusTranscriptExtracted,
		gen.LessonAnalysisStatusChunksReady,
		gen.LessonAnalysisStatusDone,
		gen.LessonAnalysisStatusProcessing:
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
	// A failed (re-)transcribe invalidates the whole pipeline: its transcript is
	// gone, so any chunks/interactions from a PREVIOUS run are stale. Checked FIRST
	// — before chunkState==Succeeded — so a leftover succeeded chunk task cannot
	// mask a failed re-transcribe (reported bug #15: "Phân đoạn: 4 đoạn" green under
	// a red "Phiên âm thất bại" after reload). Uses the SAME recency-aware predicate
	// as the artifact suppression in GetLessonAnalysis, so by construction:
	// invalidated ⟹ status ERROR (never ChunksReady/DONE with a blanked payload),
	// and a lesson recovered by a NEWER successful run derives its real status.
	case transcriptInvalidated(latest):
		out.Status = gen.LessonAnalysisStatusError
	case chunkState == string(taskqueue.StatusSucceeded):
		out.Status = gen.LessonAnalysisStatusChunksReady
	case transcribeState == string(taskqueue.StatusSucceeded):
		out.Status = gen.LessonAnalysisStatusTranscriptExtracted
	case transcribeState == string(taskqueue.StatusProcessing) || chunkState == string(taskqueue.StatusProcessing):
		out.Status = gen.LessonAnalysisStatusPending
	case chunkState == string(taskqueue.StatusFailed):
		out.Status = gen.LessonAnalysisStatusError
	}
	// Any successfully completed quiz_gen task means the lesson is
	// fully analyzed — but only if no upstream stage has failed.
	// A stale quiz_gen from a previous run must not mask a failed
	// re-run of chunk or transcribe.
	hasSucceededInteractions := false
	hasFailedUpstream := transcriptInvalidated(latest) ||
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
	case string(taskqueue.StatusProcessing), string(taskqueue.StatusInqueued):
		if out.Status == gen.LessonAnalysisStatusPending {
			out.Status = gen.LessonAnalysisStatusProcessing
		}
	case string(taskqueue.StatusFailed):
		if out.Status == gen.LessonAnalysisStatusPending {
			out.Status = gen.LessonAnalysisStatusError
		}
	}

	// Propagate the driving failed task's error message so the FE shows the real
	// cause after a reload (e.g. "phiên âm bị lặp bất thường…") instead of its
	// generic "Thao tác thất bại." fallback. Preference order mirrors the status
	// derivation: the failed transcript-producing task, then a failed chunk, then
	// a failed pipeline_run.
	if out.Status == gen.LessonAnalysisStatusError {
		for _, taskType := range []string{"transcribe", "chunk", "pipeline_run"} {
			for _, t := range latest {
				if t.TaskType == taskType && t.Status == string(taskqueue.StatusFailed) && t.ErrorMsg != "" {
					out.ErrorMsg = pgtype.Text{String: t.ErrorMsg, Valid: true}
					return out
				}
			}
		}
	}
	return out
}

// transcriptInvalidated reports whether the lesson's transcript has been
// destroyed by a failed (re-)transcribe, which transitively invalidates every
// downstream artifact (chunks, interactions). Grounded in write-path semantics:
// RunExtract deletes the FDB transcript/segments AND the PG chunks/interactions
// UP FRONT, so once a transcribe run fails there is no valid transcript for any
// surviving artifact rows to belong to (rows can survive from runs on older
// binaries that cleaned up only on success).
//
// Only the NEWEST transcript-producing row (task_type transcribe or
// pipeline_run, ordered by (created_at, id) — the same ordering
// ListLatestTaskPerLesson uses) is consulted: `latest` is latest-PER-KIND, so an
// old failed transcribe row can coexist with a NEWER succeeded pipeline_run
// (whose composite run rebuilt the transcript without writing a transcribe row).
// An order-blind "any failed transcribe" check would blank such a fully
// recovered lesson forever.
//
// A failed CHUNK task never invalidates: the transcript is intact and RunChunk
// replaces chunks atomically only on success, so existing chunks still describe
// the current transcript. A failed pipeline_run counts only while it died in its
// transcribe stage (progress_step empty or pre-CHUNKING) — once it reached
// CHUNKING/GENERATING the transcribe stage had completed and the transcript is
// valid. Known window (accepted): a freshly-enqueued retry row becomes the
// newest and un-invalidates for the seconds until RunExtract's up-front wipe
// runs; suppressing on inqueued would break the seeded processing fixtures.
func transcriptInvalidated(latest []taskqueue.Task) bool {
	var r *taskqueue.Task
	for i := range latest {
		t := &latest[i]
		if t.TaskType != "transcribe" && t.TaskType != "pipeline_run" {
			continue
		}
		if r == nil ||
			t.CreatedAt.Time.After(r.CreatedAt.Time) ||
			(t.CreatedAt.Time.Equal(r.CreatedAt.Time) && bytes.Compare(t.ID.Bytes[:], r.ID.Bytes[:]) > 0) {
			r = t
		}
	}
	if r == nil || r.Status != string(taskqueue.StatusFailed) {
		return false
	}
	if r.TaskType == "transcribe" {
		return true
	}
	return !strings.Contains(r.ProgressStep, "CHUNKING") && !strings.Contains(r.ProgressStep, "GENERATING")
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
			string(taskqueue.StatusInqueued):
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
	// Artifact CEILING (mirror of the floor above): once no task is failing / queued /
	// freshly-processing, the ARTIFACTS are the source of truth, so the derived status
	// must not exceed what they support. A leftover SUCCEEDED chunk/quiz_gen/pipeline_run
	// task — e.g. after a re-transcribe or reset wiped the chunks + interactions — would
	// otherwise keep reporting CHUNKS_READY/DONE with no chunks, pinning the stepper on
	// the locked "Bài tập" step instead of the runnable "Phân đoạn" step. (Reaching this
	// point implies a downstream stage once succeeded ⟹ the transcript exists, so
	// capping at TRANSCRIPT_EXTRACTED when chunks are gone is correct.)
	if !hasInteractions && status == gen.LessonAnalysisStatusDone {
		status = gen.LessonAnalysisStatusChunksReady
	}
	if !hasChunks &&
		(status == gen.LessonAnalysisStatusChunksReady || status == gen.LessonAnalysisStatusDone) {
		status = gen.LessonAnalysisStatusTranscriptExtracted
	}
	return status
}
