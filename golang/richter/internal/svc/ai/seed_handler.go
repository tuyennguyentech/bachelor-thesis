package ai

// seed_handler.go — test-only HTTP endpoint for E2E fixture setup.
//
// Enabled only when RICHTER_ALLOW_TEST_SEED=true (set in richter.test.toml via
// Viper env-override or explicitly). The endpoint seeds a lesson with fake
// transcript chunks and a synthetic "succeeded chunk" task row so that E2E
// tests can start from an "already analyzed" state without triggering real
// Gemini calls.
//
// Security: returns 404 when the env var is not set. Never commit
// richter.local.toml or production configs with this flag enabled.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedChunkInput describes one chunk to create.
type seedChunkInput struct {
	Transcript   string  `json:"transcript"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Summary      string  `json:"summary"`
}

// seedSegmentInput describes one lesson-level transcript segment — i.e. one row
// of what GetLessonAnalysis returns as `transcript_segments` (the video tab's
// InteractiveTranscript + the "Xử lý video" step render these, NOT the per-chunk
// transcripts above).
type seedSegmentInput struct {
	Text         string  `json:"text"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
}

// seedAnalyzedLessonRequest is the JSON body for the seed endpoint.
type seedAnalyzedLessonRequest struct {
	LessonID string           `json:"lesson_id"`
	Chunks   []seedChunkInput `json:"chunks"`
	// Segments, when present, are written to FDB as the lesson-level transcript
	// segments (SaveSegments + SaveTranscript). Independent of Chunks.
	Segments []seedSegmentInput `json:"segments"`
	// PipelineRunStatus, when non-empty (e.g. "processing"), seeds a SINGLE
	// pipeline_run task in that status INSTEAD of the synthetic succeeded
	// transcribe/chunk tasks (and skips the chunks_ready floor). This reproduces
	// the Quick-Create mid-pipeline state: segments already saved to FDB while the
	// composite task is still PROCESSING and NO task has SUCCEEDED — the exact
	// state that regressed the transcript display on both tabs.
	PipelineRunStatus string `json:"pipeline_run_status"`
	// PipelineRunStage sets that task's progress_step (e.g. "CHUNKING"/"GENERATING")
	// so the client-side tracker's mid-run segment load is exercised too. Ignored
	// when PipelineRunStatus is empty.
	PipelineRunStage string `json:"pipeline_run_stage"`
	// PipelineRunTaskType overrides the seeded task's task_type (default "pipeline_run").
	// Set to "transcribe"/"chunk" to seed a STANDALONE in-progress task instead of a
	// composite pipeline — used by FE tests that contrast the detailed per-sub-step
	// strip (standalone) against the hidden strip (pipeline). Ignored when
	// PipelineRunStatus is empty.
	PipelineRunTaskType string `json:"pipeline_run_task_type"`
	// PipelineRunError sets the seeded task's error_msg (meaningful with
	// PipelineRunStatus="failed") so E2E tests can assert the real failure text is
	// surfaced after a reload. Ignored when PipelineRunStatus is empty.
	PipelineRunError string `json:"pipeline_run_error"`
}

// seedAnalyzedLessonResponse is the JSON response.
type seedAnalyzedLessonResponse struct {
	ChunkIDs []string `json:"chunk_ids"`
}

// TestSeedHandler returns the HTTP handler for the test-seed endpoint.
// Returns ("", nil) when api.allow_test_seed is not true in the active
// config (set only in richter.test.toml) so callers can skip registration.
func (s *AISvc) TestSeedHandler() (string, http.Handler) {
	if !s.apiCfg.AllowTestSeed {
		return "", nil
	}
	pattern := "POST /richter/v1/test/seed-analyzed-lesson"
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		var req seedAnalyzedLessonRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.LessonID == "" {
			http.Error(w, "lesson_id is required", http.StatusBadRequest)
			return
		}

		lessonID := pgtype.UUID{}
		if err := lessonID.Scan(req.LessonID); err != nil {
			http.Error(w, "invalid lesson_id: "+err.Error(), http.StatusBadRequest)
			return
		}

		chunkIDs, err := s.seedAnalyzedLesson(ctx, lessonID, req)
		if err != nil {
			s.log.ErrorContext(ctx, "seed-analyzed-lesson: failed", "err", err)
			http.Error(w, "seed failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(seedAnalyzedLessonResponse{ChunkIDs: chunkIDs})
	})
	return pattern, handler
}

// seedAnalyzedLesson inserts transcript chunks in PG, stores their transcripts
// in FDB, upserts the lesson_analyses row to chunks_ready, and inserts a
// synthetic succeeded task row so the task-based preflight checks pass.
// Returns the list of inserted chunk UUIDs.
func (s *AISvc) seedAnalyzedLesson(
	ctx context.Context,
	lessonID pgtype.UUID,
	req seedAnalyzedLessonRequest,
) ([]string, error) {
	chunks := req.Chunks
	// Mid-pipeline mode: seed a running pipeline_run task with NO succeeded task
	// (see the request struct doc). In that mode we do NOT default-insert a chunk,
	// so the state is faithfully "transcribed, not yet chunked".
	midPipeline := req.PipelineRunStatus != ""
	if len(chunks) == 0 && !midPipeline {
		// Default: one generic chunk so the lesson appears analyzed.
		chunks = []seedChunkInput{
			{
				Transcript:   "Test transcript content for seeded lesson.",
				StartSeconds: 0,
				EndSeconds:   7,
				Summary:      "Seeded chunk",
			},
		}
	}

	// Lookup a user id to use as task created_by (any user will do).
	var createdBy pgtype.UUID
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, conn *pgxpool.Conn) error {
		return conn.QueryRow(ctx, "SELECT id FROM users LIMIT 1").Scan(&createdBy)
	}); err != nil {
		return nil, err
	}

	// Delete any existing chunks for this lesson so seeds are idempotent.
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		return nil, err
	}

	// Delete any existing tasks for this lesson to avoid active-task cap conflicts.
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteTasksForLesson(ctx, lessonID)
	}); err != nil {
		return nil, err
	}

	// Write lesson-level transcript segments to FDB (the transcriptSegments the
	// video tab + step render). These are what GetLessonAnalysis must return
	// UNCONDITIONALLY — even while the pipeline_run below is still PROCESSING.
	lessonIDStr := lessonID.String()
	if len(req.Segments) > 0 {
		segs := make([]segment.Segment, len(req.Segments))
		texts := make([]string, len(req.Segments))
		for i, sg := range req.Segments {
			segs[i] = segment.Segment{
				StartSeconds: float32(sg.StartSeconds),
				EndSeconds:   float32(sg.EndSeconds),
				Text:         sg.Text,
			}
			texts[i] = sg.Text
		}
		if err := segment.SaveSegments(s.kv, lessonIDStr, segs); err != nil {
			return nil, err
		}
		if err := segment.SaveTranscript(s.kv, lessonIDStr, strings.Join(texts, " ")); err != nil {
			return nil, err
		}
	}

	// Insert chunks in PG and write transcripts to FDB.
	chunkIDs := make([]string, 0, len(chunks))
	for i, c := range chunks {
		row, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
			return q.InsertLessonTranscriptChunk(ctx, gen.InsertLessonTranscriptChunkParams{
				LessonID:            lessonID,
				OrderIndex:          int32(i),
				StartSeconds:        c.StartSeconds,
				EndSeconds:          c.EndSeconds,
				Summary:             c.Summary,
				QuestionCountConfig: 2,
			})
		})
		if err != nil {
			return nil, err
		}
		chunkIDStr := row.ID.String()
		if c.Transcript != "" {
			if err := segment.SaveChunkTranscript(s.kv, chunkIDStr, c.Transcript); err != nil {
				return nil, err
			}
		}
		chunkIDs = append(chunkIDs, chunkIDStr)
	}

	// Mid-pipeline mode: a single PROCESSING pipeline_run task, no succeeded task
	// and no chunks_ready floor — the derived status comes purely from this running
	// task, matching a real Quick-Create pipeline that has transcribed but not yet
	// finished. Returns early so the succeeded-task seeding below is skipped.
	if midPipeline {
		taskType := "pipeline_run"
		if req.PipelineRunTaskType != "" {
			taskType = req.PipelineRunTaskType
		}
		taskID := pgtype.UUID{Bytes: uuid.New(), Valid: true}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, conn *pgxpool.Conn) error {
			if _, err := q.InsertSeededTask(ctx, gen.InsertSeededTaskParams{
				ID:           taskID,
				LessonID:     lessonID,
				ChunkID:      pgtype.UUID{},
				TaskType:     taskType,
				Status:       gen.TaskStatus(req.PipelineRunStatus),
				InputPayload: []byte{},
				CreatedBy:    createdBy,
			}); err != nil {
				return err
			}
			if req.PipelineRunStage != "" {
				if _, err := conn.Exec(ctx, "UPDATE tasks SET progress_step = $1 WHERE id = $2", req.PipelineRunStage, taskID); err != nil {
					return err
				}
			}
			if req.PipelineRunError != "" {
				if _, err := conn.Exec(ctx, "UPDATE tasks SET error_msg = $1 WHERE id = $2", req.PipelineRunError, taskID); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return nil, err
		}
		return chunkIDs, nil
	}

	// Upsert lesson_analyses to chunks_ready so GetLessonAnalysis returns a
	// meaningful status to the frontend.
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   gen.LessonAnalysisStatusChunksReady,
			ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return nil, err
	}

	// Insert synthetic succeeded task rows so preflight checks pass:
	//   - CHUNK_TRANSCRIPT preflight requires a succeeded "transcribe" task.
	//   - GENERATE_INTERACTIONS preflight requires chunks to exist (already done above).
	for _, taskType := range []string{"transcribe", "chunk"} {
		taskID := pgtype.UUID{Bytes: uuid.New(), Valid: true}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			_, err := q.InsertSeededTask(ctx, gen.InsertSeededTaskParams{
				ID:           taskID,
				LessonID:     lessonID,
				ChunkID:      pgtype.UUID{},
				TaskType:     taskType,
				Status:       gen.TaskStatus("succeeded"),
				InputPayload: []byte{},
				CreatedBy:    createdBy,
			})
			return err
		}); err != nil {
			return nil, err
		}
	}

	return chunkIDs, nil
}
