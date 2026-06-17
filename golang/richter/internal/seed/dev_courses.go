package seed

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
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
					if err := s.seedLessonAnalysis(ctx, lesson.ID, owner.ID, l.Analysis); err != nil {
						s.log.ErrorContext(ctx, "seed: failed to seed analysis", "lesson", l.Title, "err", err)
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

func (s *SeederSvc) seedLessonAnalysis(ctx context.Context, lessonID pgtype.UUID, createdBy pgtype.UUID, a *devAnalysisSpec) error {
	// Write transcript to FDB before marking analysis as done; if FDB fails we
	// don't want a "done" status with no transcript in the DB. Always go
	// through the segment helper so the wire format stays protobuf.
	if a.Transcript != "" {
		if err := segment.SaveTranscript(s.kv, lessonID.String(), a.Transcript); err != nil {
			return fmt.Errorf("seed: FDB transcript write failed: %w", err)
		}
	}
	taskID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("seed: failed to generate task ID: %w", err)
	}
	var tid pgtype.UUID
	tid.Bytes = [16]byte(taskID)
	tid.Valid = true

	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.InsertTask(ctx, gen.InsertTaskParams{
			ID:           tid,
			LessonID:     lessonID,
			TaskType:     "quiz_gen",
			Status:       gen.TaskStatusSucceeded,
			InputPayload: nil,
			CreatedBy:    createdBy,
		})
		return err
	}); err != nil {
		return fmt.Errorf("insert task: %w", err)
	}

	// Delete old chunks, old interactions, then insert fresh chunks + interactions
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		if err := q.DeleteLessonTranscriptChunks(ctx, lessonID); err != nil {
			return err
		}
		return q.DeleteLessonInteractionsByLesson(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete old chunks/interactions: %w", err)
	}

	// Defensive: both the order_index assignment below and the
	// attribute-by-start_seconds loop further down assume chunks are in
	// ascending temporal order (the "last chunk that has started" fallback).
	// Sort to match the runtime resolver (resolveChunkForSeconds, which sorts)
	// so an out-of-order seed JSON can never mis-attribute a question to the
	// wrong chunk and corrupt the per-chunk heatmap.
	sort.SliceStable(a.Chunks, func(i, j int) bool {
		return a.Chunks[i].StartSeconds < a.Chunks[j].StartSeconds
	})

	// Insert chunks and build a map: start_seconds → chunk.id
	chunkMap := make(map[float64]pgtype.UUID)
	for i, cs := range a.Chunks {
		chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
			return q.InsertLessonTranscriptChunk(ctx, gen.InsertLessonTranscriptChunkParams{
				LessonID:            lessonID,
				OrderIndex:          int32(i),
				StartSeconds:        cs.StartSeconds,
				EndSeconds:          cs.EndSeconds,
				Summary:             cs.Summary,
				QuestionCountConfig: 1,
				CoherenceScore:      0.0,
			})
		})
		if err != nil {
			return fmt.Errorf("insert chunk %d: %w", i, err)
		}
		chunkMap[cs.StartSeconds] = chunk.ID
	}

	for i, qspec := range a.Questions {
		configJSON, err := json.Marshal(struct {
			Options       []string `json:"options"`
			CorrectAnswer int32    `json:"correct_answer"`
		}{Options: qspec.Options, CorrectAnswer: qspec.CorrectAnswer})
		if err != nil {
			return fmt.Errorf("marshal config for interaction %d: %w", i, err)
		}
		// Attribute the question to a chunk by start_seconds. Prefer the chunk
		// whose [start, end) range contains it; otherwise fall back to the most
		// recent chunk that has started (gap / past-last) or the first chunk
		// (before everything). Never leave it NULL — a NULL chunk_id hides the
		// question from the per-chunk heatmap even though students answer it.
		chunkID := pgtype.UUID{}
		matched := false
		for _, cs := range a.Chunks {
			cid := chunkMap[cs.StartSeconds]
			if qspec.StartSeconds >= cs.StartSeconds && qspec.StartSeconds < cs.EndSeconds {
				chunkID = cid
				matched = true
				break
			}
			if qspec.StartSeconds >= cs.StartSeconds {
				chunkID = cid // last chunk that has started by this timestamp
			}
		}
		if !matched && !chunkID.Valid && len(a.Chunks) > 0 {
			chunkID = chunkMap[a.Chunks[0].StartSeconds] // before the first chunk
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
	return nil
}
