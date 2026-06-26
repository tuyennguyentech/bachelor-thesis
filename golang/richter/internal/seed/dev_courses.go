package seed

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/samber/do/v2"
)

func (s *SeederSvc) seedDevCourses(ctx context.Context, courses []devCourseSpec) error {
	type orgCache struct {
		org    gen.Organization
		titles map[string]struct{}
	}
	orgs := make(map[string]*orgCache)

	for _, c := range courses {
		if _, ok := orgs[c.OrgSlug]; !ok {
			org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
				return q.GetOrganizationBySlug(ctx, c.OrgSlug)
			})
			if err != nil {
				return fmt.Errorf("lookup org %s: %w", c.OrgSlug, err)
			}
			existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
				return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{
					OrganizationID: org.ID,
					Limit:          1000,
					Offset:         0,
				})
			})
			if err != nil {
				return fmt.Errorf("list courses for org %s: %w", c.OrgSlug, err)
			}
			titles := make(map[string]struct{}, len(existing))
			for _, e := range existing {
				titles[e.Title] = struct{}{}
			}
			orgs[c.OrgSlug] = &orgCache{org: org, titles: titles}
		}
		oc := orgs[c.OrgSlug]

		if _, exists := oc.titles[c.Title]; exists {
			s.log.InfoContext(ctx, "seed: dev course already exists, skipping", "org", c.OrgSlug, "title", c.Title)
			continue
		}

		owner, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, c.OwnerEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup owner %s for course %q: %w", c.OwnerEmail, c.Title, err)
		}

		course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
			return q.CreateCourse(ctx, gen.CreateCourseParams{
				OrganizationID: oc.org.ID,
				OwnerID:        owner.ID,
				Title:          c.Title,
				Description:    devDescToPgText(c.Description),
			})
		})
		if err != nil {
			return fmt.Errorf("create course %q in org %s: %w", c.Title, c.OrgSlug, err)
		}

		if status := gen.CourseStatus(c.Status); status != gen.CourseStatusDraft {
			course, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
				return q.UpdateCourseStatus(ctx, gen.UpdateCourseStatusParams{
					ID:     course.ID,
					Status: status,
				})
			})
			if err != nil {
				return fmt.Errorf("update status for course %q: %w", c.Title, err)
			}
		}

		for i, m := range c.Modules {
			module, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseModule, error) {
				return q.CreateCourseModule(ctx, gen.CreateCourseModuleParams{
					CourseID:   course.ID,
					Title:      m.Title,
					OrderIndex: int32(i),
				})
			})
			if err != nil {
				return fmt.Errorf("create module %d %q for course %q: %w", i, m.Title, c.Title, err)
			}

			for j, l := range m.Lessons {
				lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
					return q.CreateLesson(ctx, gen.CreateLessonParams{
						ModuleID:    module.ID,
						Title:       l.Title,
						Description: devDescToPgText(l.Description),
						OrderIndex:  int32(j),
					})
				})
				if err != nil {
					return fmt.Errorf("create lesson %d %q in module %q: %w", j, l.Title, m.Title, err)
				}

				if l.VideoKey != "" {
					_, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
						return q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
							ID:              lesson.ID,
							VideoStorageKey: pgtype.Text{String: l.VideoKey, Valid: true},
							DurationSeconds: pgtype.Int4{Int32: l.DurationSecs, Valid: true},
						})
					})
					if err != nil {
						s.log.WarnContext(ctx, "seed: failed to set video for lesson", "lesson", l.Title, "err", err)
					}
				}

				if l.Analysis != nil {
					runReal := false
					if c.Title == "Tự học Machine Learning" && l.VideoKey != "" && s.pg.Config().ConnConfig.Database != "dyadia_test" {
						localVideoPath := "seed-assets/videos/ml/" + filepath.Base(l.VideoKey)
						if _, err := os.Stat(localVideoPath); err == nil {
							runReal = true
						}
					}

					if runReal {
						s.log.InfoContext(ctx, "seed: running real video analysis pipeline", "lesson", l.Title)
						if err := s.seedLessonRealAnalysis(ctx, lesson.ID, owner.ID, l); err != nil {
							return fmt.Errorf("seed real analysis for lesson %q: %w", l.Title, err)
						}
					} else {
						if err := s.seedLessonAnalysis(ctx, lesson.ID, owner.ID, l.Analysis); err != nil {
							return fmt.Errorf("seed analysis for lesson %q: %w", l.Title, err)
						}
					}
				}
			}
		}
		oc.titles[c.Title] = struct{}{}
		s.log.InfoContext(ctx, "seed: dev course created", "org", c.OrgSlug, "title", c.Title,
			"modules", len(c.Modules))
	}
	return nil
}

// seedDevLessonVideoKeys patches video_storage_key on existing lessons that have
// a video_key in the seed data but none in the DB (idempotent: skips if already set).
func (s *SeederSvc) seedDevLessonVideoKeys(ctx context.Context, courses []devCourseSpec) error {
	for _, c := range courses {
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, c.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", c.OrgSlug, err)
		}

		dbCourses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: org.ID, Limit: 1000, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list courses for org %s: %w", c.OrgSlug, err)
		}
		var courseID pgtype.UUID
		for _, dc := range dbCourses {
			if dc.Title == c.Title {
				courseID = dc.ID
				break
			}
		}
		if !courseID.Valid {
			continue
		}

		dbModules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
			return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: courseID, Limit: 100, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list modules for course %q: %w", c.Title, err)
		}

		for _, m := range c.Modules {
			var moduleID pgtype.UUID
			for _, dm := range dbModules {
				if dm.Title == m.Title {
					moduleID = dm.ID
					break
				}
			}
			if !moduleID.Valid {
				continue
			}

			dbLessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
				return q.ListLessons(ctx, gen.ListLessonsParams{ModuleID: moduleID, Limit: 100, Offset: 0})
			})
			if err != nil {
				return fmt.Errorf("list lessons for module %q: %w", m.Title, err)
			}

			for _, l := range m.Lessons {
				if l.VideoKey == "" {
					continue
				}
				for _, dl := range dbLessons {
					if dl.Title != l.Title {
						continue
					}
					if dl.VideoStorageKey.Valid {
						break
					}
					_, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
						return q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
							ID:              dl.ID,
							VideoStorageKey: pgtype.Text{String: l.VideoKey, Valid: true},
							DurationSeconds: pgtype.Int4{Int32: l.DurationSecs, Valid: true},
						})
					})
					if err != nil {
						s.log.WarnContext(ctx, "seed: failed to set video key for lesson", "lesson", l.Title, "err", err)
					} else {
						s.log.InfoContext(ctx, "seed: video key set for lesson", "lesson", l.Title, "key", l.VideoKey)
					}
					break
				}
			}
		}
	}
	return nil
}

// deriveSeedSegments splits a plain transcript into sentence-level pieces and
// distributes them across [0, totalDuration] proportional to length, so seeded
// lessons have an interactive, video-synced transcript. Returns nil when there
// is no usable duration (no chunks) so callers fall back to plain text.
func deriveSeedSegments(transcript string, totalDuration float64) []segment.Segment {
	if totalDuration <= 0 {
		return nil
	}
	pieces := splitSentences(transcript)
	if len(pieces) == 0 {
		return nil
	}
	totalChars := 0
	for _, p := range pieces {
		totalChars += len([]rune(p))
	}
	if totalChars == 0 {
		return nil
	}
	segs := make([]segment.Segment, 0, len(pieces))
	cumChars := 0
	for _, p := range pieces {
		start := totalDuration * float64(cumChars) / float64(totalChars)
		cumChars += len([]rune(p))
		end := totalDuration * float64(cumChars) / float64(totalChars)
		segs = append(segs, segment.Segment{
			StartSeconds: float32(start),
			EndSeconds:   float32(end),
			Text:         p,
		})
	}
	return segs
}

// splitSentences breaks text into trimmed, non-empty sentence-ish pieces on
// sentence-final punctuation and newlines.
func splitSentences(text string) []string {
	var out []string
	var b strings.Builder
	flush := func() {
		if s := strings.TrimSpace(b.String()); s != "" {
			out = append(out, s)
		}
		b.Reset()
	}
	for _, r := range text {
		b.WriteRune(r)
		if r == '.' || r == '!' || r == '?' || r == '\n' {
			flush()
		}
	}
	flush()
	return out
}

func (s *SeederSvc) seedLessonAnalysis(ctx context.Context, lessonID pgtype.UUID, createdBy pgtype.UUID, a *devAnalysisSpec) error {
	// The dev seeder produces analyzed lessons by running the REAL transcript
	// pipeline (transcript.Service.RunExtract + RunChunk) with the AI boundaries
	// (STT + chunking) backed by golden fixtures built from the curated JSON. This
	// yields the same FDB(transcript+segments) + Postgres(chunks) + coherence a real
	// Whisper/Gemini run would — no dual-store divergence, deterministic, no network.

	// A coherent analysis requires a transcript. Curated chunks/questions with no
	// transcript can never form a consistent lesson, so fail loudly.
	if a.Transcript == "" {
		if len(a.Questions) > 0 || len(a.Chunks) > 0 {
			return fmt.Errorf("lesson %s has chunks/questions but no transcript", lessonID.String())
		}
		return nil // nothing to analyze
	}

	// Resolve chunk boundaries. Curated chunks win; if the lesson has questions but
	// no chunks (a real inconsistency in some seed JSON), derive a single chunk over
	// the whole timeline so every question still attaches to a real chunk.
	chunks := append([]devChunkSpec(nil), a.Chunks...)
	totalDur := 0.0
	for _, c := range chunks {
		if c.EndSeconds > totalDur {
			totalDur = c.EndSeconds
		}
	}
	if len(chunks) == 0 {
		for _, q := range a.Questions {
			if q.StartSeconds+1 > totalDur {
				totalDur = q.StartSeconds + 1
			}
		}
		if totalDur <= 0 {
			totalDur = 60
		}
		chunks = []devChunkSpec{{StartSeconds: 0, EndSeconds: totalDur, Summary: "Toàn bài"}}
	}
	// Chunks must be in ascending temporal order: RunChunk assigns order_index in
	// slice order, and the question-attribution loop assumes ascending starts.
	sort.SliceStable(chunks, func(i, j int) bool {
		return chunks[i].StartSeconds < chunks[j].StartSeconds
	})

	chunkJSON, err := buildSeedChunkJSON(chunks)
	if err != nil {
		return fmt.Errorf("build chunk fixture for lesson %s: %w", lessonID.String(), err)
	}

	// Run the real transcribe + chunk stages with golden fixtures. RunExtract writes
	// transcript+segments to FDB and clears stale downstream data; RunChunk inserts
	// chunks (with real coherence scores) and writes per-chunk FDB transcripts.
	ts := s.newSeedTranscriptService(a.Transcript, totalDur, chunkJSON)
	if err := ts.RunExtract(ctx, lessonID, "seed", "vi", noopProgress); err != nil {
		return fmt.Errorf("RunExtract lesson %s: %w", lessonID.String(), err)
	}
	if err := ts.RunChunk(ctx, lessonID, noopProgress); err != nil {
		return fmt.Errorf("RunChunk lesson %s: %w", lessonID.String(), err)
	}

	// Load the chunks RunChunk just created so curated questions attach to real
	// chunk IDs (chunk_id is therefore never NULL).
	dbChunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 5000, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("list chunks lesson %s: %w", lessonID.String(), err)
	}
	if len(dbChunks) == 0 {
		return fmt.Errorf("lesson %s produced no chunks", lessonID.String())
	}
	sort.SliceStable(dbChunks, func(i, j int) bool {
		return dbChunks[i].StartSeconds < dbChunks[j].StartSeconds
	})

	// Insert curated (authored) questions, attributed to the real chunks. Routing
	// authored questions through generation.Service would overwrite their
	// start_seconds and discard the curated content, so they are inserted directly
	// here — the divergence bug lived in transcribe/chunk, which now run for real.
	for i, qspec := range a.Questions {
		chunkID := dbChunks[0].ID
		for _, c := range dbChunks {
			if qspec.StartSeconds >= c.StartSeconds && qspec.StartSeconds < c.EndSeconds {
				chunkID = c.ID
				break
			}
			if qspec.StartSeconds >= c.StartSeconds {
				chunkID = c.ID // last chunk that has started by this timestamp
			}
		}
		configJSON, err := json.Marshal(struct {
			Options       []string `json:"options"`
			CorrectAnswer int32    `json:"correct_answer"`
		}{Options: qspec.Options, CorrectAnswer: qspec.CorrectAnswer})
		if err != nil {
			return fmt.Errorf("marshal config for interaction %d: %w", i, err)
		}
		if _, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
			return q.InsertLessonInteraction(ctx, gen.InsertLessonInteractionParams{
				LessonID:     lessonID,
				ChunkID:      chunkID,
				Kind:         "mcq",
				StartSeconds: float32(qspec.StartSeconds),
				OrderIndex:   int32(i),
				Prompt:       qspec.QuestionText,
				Explanation:  qspec.Explanation,
				Config:       configJSON,
				MaxScore:     1.0,
				GeneratedBy:  "seed",
			})
		}); err != nil {
			return fmt.Errorf("create interaction %d: %w", i, err)
		}
	}

	// Coherent succeeded task set (transcribe+chunk+quiz_gen) so GetLessonAnalysis
	// derives DONE and loads the FDB transcript (deriveAnalysisFromTasks +
	// canLoadTranscript both key off these task rows).
	for _, taskType := range []string{"transcribe", "chunk", "quiz_gen"} {
		taskID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generate task ID: %w", err)
		}
		tid := pgtype.UUID{Bytes: [16]byte(taskID), Valid: true}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			_, err := q.InsertSeededTask(ctx, gen.InsertSeededTaskParams{
				ID:           tid,
				LessonID:     lessonID,
				TaskType:     taskType,
				Status:       gen.TaskStatusSucceeded,
				InputPayload: nil,
				CreatedBy:    createdBy,
			})
			return err
		}); err != nil {
			return fmt.Errorf("insert %s task: %w", taskType, err)
		}
	}

	return nil
}

func (s *SeederSvc) seedLessonRealAnalysis(ctx context.Context, lessonID pgtype.UUID, createdBy pgtype.UUID, l devLessonSpec) error {
	// 1. Idempotency Check: if chunks and interactions already exist, skip.
	dbChunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
			LessonID: lessonID,
			Limit:    1,
			Offset:   0,
		})
	})
	if err == nil && len(dbChunks) > 0 {
		dbInteractions, intErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
			return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
				LessonID: lessonID,
				Limit:    1,
				Offset:   0,
			})
		})
		if intErr == nil && len(dbInteractions) > 0 {
			s.log.InfoContext(ctx, "seed: lesson already has real analysis, skipping pipeline run", "lesson_id", lessonID.String(), "title", l.Title)
			return nil
		}
	}

	// 2. Pre-upload video if not already present in S3 bucket.
	if _, err := s.s3client.StatObject(ctx, s.s3cfg.Bucket, l.VideoKey, minio.StatObjectOptions{}); err != nil {
		localVideoPath := "seed-assets/videos/ml/" + filepath.Base(l.VideoKey)
		s.log.InfoContext(ctx, "seed: uploading video to S3 before real analysis", "key", l.VideoKey, "file", localVideoPath)
		if err := s.uploadFromFile(ctx, l.VideoKey, localVideoPath); err != nil {
			return fmt.Errorf("pre-upload video %q: %w", localVideoPath, err)
		}
		s.log.InfoContext(ctx, "seed: video uploaded successfully", "key", l.VideoKey)
	}

	// 3. Clear any partial analysis / chunks / tasks to ensure a clean start
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete chunks: %w", err)
	}
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteTasksForLesson(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete tasks: %w", err)
	}

	// 4. Retrieve *ai.AISvc
	aiSvc, err := do.Invoke[*ai.AISvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke AISvc: %w", err)
	}

	// 5. Run transcription
	s.log.InfoContext(ctx, "seed: transcribing video...", "lesson_id", lessonID.String(), "key", l.VideoKey)
	err = aiSvc.Transcript().RunExtract(ctx, lessonID, l.VideoKey, "vi", func(step richterv1.AnalysisProgressStep, msg string) error {
		s.log.InfoContext(ctx, "seed pipeline [Extract]", "step", step.String(), "msg", msg)
		return nil
	})
	if err != nil {
		return fmt.Errorf("RunExtract failed: %w", err)
	}

	// 6. Run chunking
	s.log.InfoContext(ctx, "seed: chunking transcript...", "lesson_id", lessonID.String())
	err = aiSvc.Transcript().RunChunk(ctx, lessonID, func(step richterv1.AnalysisProgressStep, msg string) error {
		s.log.InfoContext(ctx, "seed pipeline [Chunk]", "step", step.String(), "msg", msg)
		return nil
	})
	if err != nil {
		return fmt.Errorf("RunChunk failed: %w", err)
	}

	// 7. Run quiz generation (interactions)
	s.log.InfoContext(ctx, "seed: generating interactions...", "lesson_id", lessonID.String())
	req := &richterv1.GenerateInteractionsRequest{
		LessonId:         uuid.UUID(lessonID.Bytes).String(),
		InteractionKinds: []richterv1.InteractionKind{
			richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE,
			richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK,
			richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
			richterv1.InteractionKind_INTERACTION_KIND_READING,
			richterv1.InteractionKind_INTERACTION_KIND_WRITING,
		},
		CountPerChunk:    1, // At least 1 exercise per chunk
		Strategy:         richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE,
		Difficulty:       "medium",
		ForceRegenerate:  true,
	}
	err = aiSvc.Generation().Run(ctx, lessonID, req, func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error {
		s.log.InfoContext(ctx, "seed pipeline [Gen]", "step", step.String(), "msg", msg, "chunkIndex", chunkIndex, "totalChunks", totalChunks)
		return nil
	})
	if err != nil {
		return fmt.Errorf("Generation failed: %w", err)
	}

	// 8. Insert the task rows as succeeded
	for _, taskType := range []string{"transcribe", "chunk", "quiz_gen"} {
		taskID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generate task ID: %w", err)
		}
		tid := pgtype.UUID{Bytes: [16]byte(taskID), Valid: true}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			_, err := q.InsertSeededTask(ctx, gen.InsertSeededTaskParams{
				ID:           tid,
				LessonID:     lessonID,
				TaskType:     taskType,
				Status:       gen.TaskStatusSucceeded,
				InputPayload: nil,
				CreatedBy:    createdBy,
			})
			return err
		}); err != nil {
			return fmt.Errorf("insert %s task: %w", taskType, err)
		}
	}

	// 9. Update lesson analysis status to done
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   gen.LessonAnalysisStatusDone,
			ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return fmt.Errorf("upsert analysis status: %w", err)
	}

	s.log.InfoContext(ctx, "seed: real video analysis pipeline completed successfully", "lesson", l.Title)
	return nil
}
