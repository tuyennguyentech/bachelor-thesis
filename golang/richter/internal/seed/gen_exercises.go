package seed

import (
	"context"
	"fmt"
	"strings"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

// genKindEnum maps CLI kind names to proto InteractionKinds.
var genKindEnum = map[string]richterv1.InteractionKind{
	"single_choice":   richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE,
	"multiple_choice": richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE,
	"fill_blank":      richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK,
	"listening":       richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
	"reading":         richterv1.InteractionKind_INTERACTION_KIND_READING,
	"writing":         richterv1.InteractionKind_INTERACTION_KIND_WRITING,
}

// GenExercisesParams configures a manual, in-process (re)generation of exercises
// for ONE lesson — the Go replacement for the removed scripts/seed/gen-exercises.py.
// It runs entirely through the real generation service (the same code path the
// dashboard "generate exercises" button uses), so nothing seeds the app outside
// richter; the result is production-consistent.
type GenExercisesParams struct {
	LessonID      string   // UUID; takes priority when set
	OrgSlug       string   // used with CourseTitle+LessonTitle when LessonID is empty
	CourseTitle   string   // used with LessonTitle to resolve the lesson
	LessonTitle   string   // resolved within OrgSlug/CourseTitle
	Kinds         []string // keys of genKindEnum
	CountPerChunk int32
	Difficulty    string
	Force         bool
}

// GenExercises (re)generates exercises for a single lesson via the real
// generation service. Idempotent unless Force is set: the generation service
// skips chunks that already have interactions when ForceRegenerate is false.
func (s *SeederSvc) GenExercises(ctx context.Context, p GenExercisesParams) error {
	if len(p.Kinds) == 0 {
		return fmt.Errorf("no interaction kinds given")
	}
	kinds := make([]richterv1.InteractionKind, 0, len(p.Kinds))
	for _, k := range p.Kinds {
		ik, ok := genKindEnum[strings.TrimSpace(k)]
		if !ok {
			return fmt.Errorf("unknown interaction kind %q (allowed: single_choice, multiple_choice, fill_blank, listening, reading, writing)", k)
		}
		kinds = append(kinds, ik)
	}

	lessonID, title, err := s.resolveLessonForGen(ctx, p)
	if err != nil {
		return err
	}
	s.log.InfoContext(ctx, "seed: generating exercises", "lesson_id", lessonID.String(), "title", title,
		"kinds", p.Kinds, "count_per_chunk", p.CountPerChunk, "difficulty", p.Difficulty, "force", p.Force)

	aiSvc, err := do.Invoke[*ai.AISvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke AISvc: %w", err)
	}
	req := &richterv1.GenerateInteractionsRequest{
		LessonId:         uuid.UUID(lessonID.Bytes).String(),
		InteractionKinds: kinds,
		CountPerChunk:    p.CountPerChunk,
		Strategy:         richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE,
		Difficulty:       p.Difficulty,
		ForceRegenerate:  p.Force,
	}
	if err := aiSvc.Generation().Run(ctx, lessonID, req, func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error {
		s.log.InfoContext(ctx, "seed gen-exercises", "step", step.String(), "msg", msg, "chunk", chunkIndex, "total", totalChunks)
		return nil
	}); err != nil {
		return fmt.Errorf("generation failed for lesson %q: %w", title, err)
	}
	s.log.InfoContext(ctx, "seed: exercises generated", "lesson_id", lessonID.String(), "title", title)
	return nil
}

// resolveLessonForGen resolves the target lesson by UUID (priority) or by
// (OrgSlug, CourseTitle, LessonTitle).
func (s *SeederSvc) resolveLessonForGen(ctx context.Context, p GenExercisesParams) (pgtype.UUID, string, error) {
	if p.LessonID != "" {
		u, err := uuid.Parse(p.LessonID)
		if err != nil {
			return pgtype.UUID{}, "", fmt.Errorf("invalid --lesson-id %q: %w", p.LessonID, err)
		}
		lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
			return q.GetLessonByID(ctx, pgtype.UUID{Bytes: u, Valid: true})
		})
		if err != nil {
			return pgtype.UUID{}, "", fmt.Errorf("lesson %s not found: %w", p.LessonID, err)
		}
		return lesson.ID, lesson.Title, nil
	}
	if p.LessonTitle == "" {
		return pgtype.UUID{}, "", fmt.Errorf("provide --lesson-id, or --lesson-title (with --org/--course-title)")
	}

	org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.GetOrganizationBySlug(ctx, p.OrgSlug)
	})
	if err != nil {
		return pgtype.UUID{}, "", fmt.Errorf("org %q not found: %w", p.OrgSlug, err)
	}
	courses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
		return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: org.ID, Limit: 1000, Offset: 0})
	})
	if err != nil {
		return pgtype.UUID{}, "", fmt.Errorf("list courses for org %q: %w", p.OrgSlug, err)
	}
	var courseID pgtype.UUID
	for _, c := range courses {
		if c.Title == p.CourseTitle {
			courseID = c.ID
			break
		}
	}
	if !courseID.Valid {
		return pgtype.UUID{}, "", fmt.Errorf("course %q not found in org %q", p.CourseTitle, p.OrgSlug)
	}
	lessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
		return q.ListLessonsByCourse(ctx, gen.ListLessonsByCourseParams{CourseID: courseID, Limit: 1000, Offset: 0})
	})
	if err != nil {
		return pgtype.UUID{}, "", fmt.Errorf("list lessons for course %q: %w", p.CourseTitle, err)
	}
	for _, l := range lessons {
		if l.Title == p.LessonTitle {
			return l.ID, l.Title, nil
		}
	}
	return pgtype.UUID{}, "", fmt.Errorf("lesson %q not found in course %q (org %q)", p.LessonTitle, p.CourseTitle, p.OrgSlug)
}
