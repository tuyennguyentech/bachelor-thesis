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

// seedAnalyzedLessonRequest is the JSON body for the seed endpoint.
type seedAnalyzedLessonRequest struct {
	LessonID string           `json:"lesson_id"`
	Chunks   []seedChunkInput `json:"chunks"`
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

		chunkIDs, err := s.seedAnalyzedLesson(ctx, lessonID, req.Chunks)
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
	chunks []seedChunkInput,
) ([]string, error) {
	if len(chunks) == 0 {
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
				CoherenceScore:      1.0,
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
			_, err := q.InsertTask(ctx, gen.InsertTaskParams{
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
