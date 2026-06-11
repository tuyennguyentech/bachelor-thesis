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

		// Grade each answer by interaction kind so that seed attempt scores are
		// realistic.  MCQ is graded by correct_answer matching; fill_blank and
		// listening are scored 0 (no real answer available in seed); reading is
		// scored 0 (no audio recording in seed).
		var totalScore, maxScore float32
		type gradedResp struct {
			interactionID pgtype.UUID
			responseJSON  []byte
			score         float32
			maxScore      float32
			idx           int
		}
		var graded []gradedResp
		for i, interaction := range interactions {
			var iScore, iMaxScore float32
			var respJSON []byte

			switch interaction.Kind {
			case "mcq", "single_choice", "multiple_choice":
				iMaxScore = 1.0
				var cfg struct {
					CorrectAnswer int `json:"correct_answer"`
				}
				_ = json.Unmarshal(interaction.Config, &cfg)
				selected := -1
				if i < len(a.Answers) {
					selected = int(a.Answers[i])
				}
				respJSON, _ = json.Marshal(struct {
					Selected int `json:"selected"`
				}{Selected: selected})
				if selected == cfg.CorrectAnswer {
					iScore = 1.0
				}

			case "fill_blank":
				// Seed doesn't supply fill-blank answers; score 0/1 (unanswered).
				iMaxScore = 1.0
				iScore = 0
				respJSON, _ = json.Marshal(struct {
					Answers []string `json:"answers"`
				}{Answers: []string{}})

			case "listening":
				// Seed doesn't supply listening answers; score 0/1 (unanswered).
				iMaxScore = 1.0
				iScore = 0
				respJSON, _ = json.Marshal(struct {
					ComprehensionAnswers []int32 `json:"comprehension_answers"`
				}{ComprehensionAnswers: []int32{}})

			case "reading":
				// Seed doesn't supply audio recordings; score 0/1 (no submission).
				iMaxScore = 1.0
				iScore = 0
				respJSON, _ = json.Marshal(struct {
					AudioObjectKey string `json:"audio_object_key"`
				}{AudioObjectKey: ""})

			default:
				// Unknown kind: skip to avoid breaking seed on new interaction types.
				continue
			}

			maxScore += iMaxScore
			if iScore > 0 {
				totalScore += iScore
			}
			graded = append(graded, gradedResp{interaction.ID, respJSON, iScore, iMaxScore, i})
		}

		// Compute a deterministic VideoWatchFraction: use spec value if set,
		// otherwise derive from score (base 0.70, +0.05 per correct answer, capped at 0.95).
		watchFraction := a.VideoWatchFraction
		if watchFraction == 0 {
			watchFraction = 0.70 + 0.05*totalScore
			if watchFraction > 0.95 {
				watchFraction = 0.95
			}
		}

		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
			attempt, err := q.UpsertLessonAttempt(ctx, gen.UpsertLessonAttemptParams{
				LessonID:           lessonID,
				UserID:             user.ID,
				TotalScore:         totalScore,
				MaxScore:           maxScore,
				Status:             "submitted",
				VideoWatchFraction: pgtype.Float4{Float32: watchFraction, Valid: true},
			})
			if err != nil {
				return gen.LessonAttempt{}, err
			}
			for _, g := range graded {
				// Deterministic TimeToAnswerMs: 2000 + 1500 * index ms (2s – 12.5s range).
				timeToAnswerMs := int32(2000 + 1500*g.idx)
				// ReplayCount: 0 for most; 1 for every third question (index % 3 == 2).
				replayCount := int32(0)
				if g.idx%3 == 2 {
					replayCount = 1
				}
				if err := q.UpsertAttemptResponse(ctx, gen.UpsertAttemptResponseParams{
					AttemptID:      attempt.ID,
					InteractionID:  g.interactionID,
					Response:       g.responseJSON,
					Score:          g.score,
					MaxScore:       g.maxScore,
					Feedback:       "",
					TimeToAnswerMs: pgtype.Int4{Int32: timeToAnswerMs, Valid: true},
					ReplayCount:    replayCount,
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
