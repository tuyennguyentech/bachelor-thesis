package seed

import (
	"context"
	"encoding/json"
	"fmt"

	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedDevAttempts seeds lesson attempt records for dev users.
// It looks up lessons by path (org→course→module→lesson) to get the lesson ID.
func (s *SeederSvc) seedDevAttempts(ctx context.Context, attempts []devAttemptSpec) error {
	for _, a := range attempts {
		user, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, a.UserEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup user %s: %w", a.UserEmail, err)
		}

		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, a.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", a.OrgSlug, err)
		}

		// Find course by title
		courses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: org.ID, Limit: 200, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list courses for org %s: %w", a.OrgSlug, err)
		}
		var courseID pgtype.UUID
		for _, c := range courses {
			if c.Title == a.CourseTitle {
				courseID = c.ID
				break
			}
		}
		if !courseID.Valid {
			s.log.InfoContext(ctx, "seed: attempt skipped — course not found", "course", a.CourseTitle)
			continue
		}

		// Find module by title
		modules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
			return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: courseID, Limit: 100, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list modules for course %s: %w", a.CourseTitle, err)
		}
		var moduleID pgtype.UUID
		for _, m := range modules {
			if m.Title == a.ModuleTitle {
				moduleID = m.ID
				break
			}
		}
		if !moduleID.Valid {
			s.log.InfoContext(ctx, "seed: attempt skipped — module not found", "module", a.ModuleTitle)
			continue
		}

		// Find lesson by title
		lessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
			return q.ListLessons(ctx, gen.ListLessonsParams{ModuleID: moduleID, Limit: 100, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list lessons for module %s: %w", a.ModuleTitle, err)
		}
		var lessonID pgtype.UUID
		for _, l := range lessons {
			if l.Title == a.LessonTitle {
				lessonID = l.ID
				break
			}
		}
		if !lessonID.Valid {
			s.log.InfoContext(ctx, "seed: attempt skipped — lesson not found", "lesson", a.LessonTitle)
			continue
		}

		// Load interactions to compute score
		interactions, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
			return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
				LessonID: lessonID,
				Limit:    100,
				Offset:   0,
			})
		})
		if err != nil || len(interactions) == 0 {
			s.log.InfoContext(ctx, "seed: attempt skipped — no interactions for lesson", "lesson", a.LessonTitle)
			continue
		}

		// Grade each answer against the MCQ config
		var totalScore, maxScore float32
		type gradedResp struct {
			interactionID pgtype.UUID
			responseJSON  []byte
			score         float32
		}
		var graded []gradedResp
		for i, interaction := range interactions {
			maxScore += 1.0
			var cfg struct {
				CorrectAnswer int `json:"correct_answer"`
			}
			_ = json.Unmarshal(interaction.Config, &cfg)
			selected := -1
			if i < len(a.Answers) {
				selected = int(a.Answers[i])
			}
			respJSON, _ := json.Marshal(struct {
				Selected int `json:"selected"`
			}{Selected: selected})
			score := float32(0)
			if selected == cfg.CorrectAnswer {
				score = 1.0
				totalScore++
			}
			graded = append(graded, gradedResp{interaction.ID, respJSON, score})
		}

		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
			attempt, err := q.UpsertLessonAttempt(ctx, gen.UpsertLessonAttemptParams{
				LessonID:   lessonID,
				UserID:     user.ID,
				TotalScore: totalScore,
				MaxScore:   maxScore,
				Status:     "submitted",
			})
			if err != nil {
				return gen.LessonAttempt{}, err
			}
			for _, g := range graded {
				if err := q.UpsertAttemptResponse(ctx, gen.UpsertAttemptResponseParams{
					AttemptID:     attempt.ID,
					InteractionID: g.interactionID,
					Response:      g.responseJSON,
					Score:         g.score,
					MaxScore:      1.0,
					Feedback:      "",
				}); err != nil {
					return gen.LessonAttempt{}, err
				}
			}
			return attempt, nil
		})
		if err != nil {
			return fmt.Errorf("upsert attempt %s/%s: %w", a.UserEmail, a.LessonTitle, err)
		}
		s.log.InfoContext(ctx, "seed: attempt seeded", "user", a.UserEmail, "lesson", a.LessonTitle, "score", fmt.Sprintf("%.0f/%.0f", totalScore, maxScore))
	}
	return nil
}
