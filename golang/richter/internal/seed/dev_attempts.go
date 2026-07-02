package seed

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai"
	"example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

const (
	mlCourseTitle = "Tự học Machine Learning"
	mlOrgSlug     = "hust-cs"
)

// mcqKinds are the interaction kinds the seeder can answer deterministically via
// the real submit flow (local grading, no Gemini/audio needed).
var mcqKinds = map[string]bool{"mcq": true, "single_choice": true}

// attemptTier is a learner profile used to generate diverse, realistic attempts:
// accuracy (P(correct) baseline), watch (video_watch_fraction baseline) and
// completion (fraction of the course the student gets through). The mix yields a
// spread of strong/average/struggling/at-risk students so the teacher analytics
// (heatmap, engagement, at-risk streaks) look varied.
type attemptTier struct {
	name       string
	accuracy   float64
	watch      float64
	completion float64
}

var attemptTiers = []attemptTier{
	{"excellent", 0.95, 0.96, 1.00},
	{"excellent", 0.91, 0.94, 1.00},
	{"good", 0.85, 0.88, 0.92},
	{"good", 0.81, 0.84, 0.88},
	{"good", 0.77, 0.82, 0.83},
	{"average", 0.70, 0.74, 0.75},
	{"average", 0.66, 0.70, 0.70},
	{"average", 0.62, 0.66, 0.66},
	{"struggling", 0.52, 0.55, 0.54},
	{"struggling", 0.45, 0.48, 0.46},
	{"at_risk", 0.34, 0.34, 0.38},
	{"at_risk", 0.27, 0.28, 0.30},
}

// detFrac returns a deterministic float in [0,1) from stable string parts, so the
// generated attempts are reproducible (idempotent) across seed runs.
func detFrac(parts ...string) float64 {
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return float64(binary.BigEndian.Uint32(sum[:4])) / 4294967296.0
}

func clampF(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

func uuidStr(u pgtype.UUID) string { return uuid.UUID(u.Bytes).String() }

// mcqInfo is the planning data for one MCQ interaction.
type mcqInfo struct {
	id      pgtype.UUID
	idStr   string
	correct int
	nopts   int
}

// lessonInfo is the planning data for one lesson (ordered, with its MCQs).
type lessonInfo struct {
	id       pgtype.UUID
	idStr    string
	duration int32
	mcqs     []mcqInfo
}

// seedDevAttempts seeds lesson attempts THROUGH THE REAL business flow — it calls
// InteractionsSvc.SubmitAttempt + AISvc.UpdateWatchProgress in-process (with a
// synthesized auth context), never a raw sqlc insert, so the analytics are
// consistent-by-construction (server grades + computes the watch fraction exactly
// as a real student session would). It covers (1) explicit attempts from
// quiz_attempts.json and (2) generated dense, diverse attempts for the ML demo
// course. Idempotent: SubmitAttempt upserts one attempt per (user, lesson).
func (s *SeederSvc) seedDevAttempts(ctx context.Context, attempts []devAttemptSpec) error {
	if err := s.seedExplicitAttempts(ctx, attempts); err != nil {
		return err
	}

	interactionsSvc, err := do.Invoke[*interactions.InteractionsSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke InteractionsSvc: %w", err)
	}
	aiSvc, err := do.Invoke[*ai.AISvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke AISvc: %w", err)
	}

	// Dense ML demo attempts only on the dev DB — the test DB keeps a small
	// footprint (the ML course there uses golden fixtures and the E2E suite does
	// not need 500 generated attempts).
	if s.pg.Config().ConnConfig.Database != "dyadia_test" {
		if err := s.seedMLDenseAttempts(ctx, interactionsSvc, aiSvc); err != nil {
			return fmt.Errorf("seed ML dense attempts: %w", err)
		}
	}
	return nil
}

// submitAttemptViaFlow drives one attempt through the production code path with a
// synthesized student auth context: an honest watch-coverage interval (so the
// server-side video_watch_fraction matches) followed by SubmitAttempt (which
// grades each response). Requires >= 1 response (SubmitAttempt rejects empty).
func (s *SeederSvc) submitAttemptViaFlow(
	ctx context.Context,
	interactionsSvc *interactions.InteractionsSvc,
	aiSvc *ai.AISvc,
	userID, lessonID pgtype.UUID,
	durationSec int32,
	responses []*richterv1.AttemptResponseInput,
	watchFrac float64,
) error {
	if len(responses) == 0 {
		return nil
	}
	claims := &jwtv1.JWTClaims{
		Sub:    uuidStr(userID),
		Role:   richterv1.UserRole_USER_ROLE_NORMAL,
		Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	}
	actx := authz.ContextWithClaims(ctx, claims)
	if durationSec > 0 && watchFrac > 0 {
		to := float32(float64(durationSec) * watchFrac)
		if _, werr := aiSvc.UpdateWatchProgress(actx, &richterv1.UpdateWatchProgressRequest{
			LessonId:           uuidStr(lessonID),
			PositionSeconds:    to,
			WatchedFromSeconds: 0,
			WatchedToSeconds:   to,
		}); werr != nil {
			s.log.WarnContext(ctx, "seed: update watch progress failed", "lesson", uuidStr(lessonID), "err", werr)
		}
	}
	_, err := interactionsSvc.SubmitAttempt(actx, &richterv1.SubmitAttemptRequest{
		LessonId:           uuidStr(lessonID),
		Responses:          responses,
		VideoWatchFraction: watchFrac,
	})
	return err
}

// mcqResponse builds an MCQ AttemptResponseInput with deterministic, display-only
// timing metrics derived from the student + interaction id.
func mcqResponse(email, intIDStr string, intID pgtype.UUID, selected int) *richterv1.AttemptResponseInput {
	replay := int32(0)
	if detFrac("r", email, intIDStr) < 0.18 {
		replay = 1
	}
	return &richterv1.AttemptResponseInput{
		InteractionId:  uuidStr(intID),
		TimeToAnswerMs: int32(2500 + int(detFrac("t", email, intIDStr)*16000)),
		ReplayCount:    replay,
		Response:       &richterv1.AttemptResponseInput_McqSelected{McqSelected: int32(selected)},
	}
}

// parseMCQ extracts (correct_answer, option_count) from a stored MCQ config.
func parseMCQ(config []byte) (correct, nopts int, ok bool) {
	var cfg struct {
		Options       []json.RawMessage `json:"options"`
		CorrectAnswer int               `json:"correct_answer"`
	}
	if json.Unmarshal(config, &cfg) != nil || len(cfg.Options) < 2 {
		return 0, 0, false
	}
	return cfg.CorrectAnswer, len(cfg.Options), true
}

// seedExplicitAttempts submits every quiz_attempts.json spec via the real flow.
// A genuine error (bad email, list/submit failure, real DB error) STOPS the seed;
// a target lesson simply absent from this DB is skipped. Used by the full dev seed
// AND by RescaleFixtures to restore attempt responses that cascade-deleted when a
// rescaled lesson's interactions were re-created.
func (s *SeederSvc) seedExplicitAttempts(ctx context.Context, attempts []devAttemptSpec) error {
	interactionsSvc, err := do.Invoke[*interactions.InteractionsSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke InteractionsSvc: %w", err)
	}
	aiSvc, err := do.Invoke[*ai.AISvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke AISvc: %w", err)
	}
	for _, a := range attempts {
		if err := s.seedExplicitAttempt(ctx, interactionsSvc, aiSvc, a); err != nil {
			return fmt.Errorf("seed explicit attempt (user %q, lesson %q): %w", a.UserEmail, a.LessonTitle, err)
		}
	}
	return nil
}

// seedExplicitAttempt submits one quiz_attempts.json spec via the real flow,
// mapping the positional answers array onto the lesson's MCQ interactions.
func (s *SeederSvc) seedExplicitAttempt(ctx context.Context, interactionsSvc *interactions.InteractionsSvc, aiSvc *ai.AISvc, a devAttemptSpec) error {
	user, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByEmail(ctx, a.UserEmail)
	})
	if err != nil {
		return fmt.Errorf("lookup user: %w", err)
	}
	lesson, ok, err := s.resolveLesson(ctx, a.OrgSlug, a.CourseTitle, a.ModuleTitle, a.LessonTitle)
	if err != nil {
		return err
	}
	if !ok {
		return nil // course/module/lesson not present in this DB — skip quietly
	}
	its, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: lesson.ID, Limit: 500, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("list interactions: %w", err)
	}
	var responses []*richterv1.AttemptResponseInput
	for i, it := range its {
		if !mcqKinds[it.Kind] || i >= len(a.Answers) {
			continue
		}
		responses = append(responses, mcqResponse(a.UserEmail, uuidStr(it.ID), it.ID, int(a.Answers[i])))
	}
	if len(responses) == 0 {
		return nil
	}
	watch := float64(a.VideoWatchFraction)
	if watch == 0 {
		watch = clampF(0.70+(detFrac("w", a.UserEmail, lesson.Title)-0.5)*0.2, 0.4, 0.95)
	}
	return s.submitAttemptViaFlow(ctx, interactionsSvc, aiSvc, user.ID, lesson.ID, durationSecs(lesson), responses, watch)
}

func durationSecs(l gen.Lesson) int32 {
	if l.DurationSeconds.Valid {
		return l.DurationSeconds.Int32
	}
	return 0
}

// resolveLesson walks org→course→module→lesson by title. ok=false (no error) when
// any segment is absent, so seeding stays robust across DBs with different content.
func (s *SeederSvc) resolveLesson(ctx context.Context, orgSlug, courseTitle, moduleTitle, lessonTitle string) (gen.Lesson, bool, error) {
	org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.GetOrganizationBySlug(ctx, orgSlug)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.Lesson{}, false, nil // org genuinely absent — skip (not an error)
		}
		return gen.Lesson{}, false, fmt.Errorf("lookup org %q: %w", orgSlug, err) // real DB error → STOP
	}
	courseID, ok, err := s.courseIDByTitle(ctx, org.ID, courseTitle)
	if err != nil || !ok {
		return gen.Lesson{}, false, err
	}
	modules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
		return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: courseID, Limit: 200, Offset: 0})
	})
	if err != nil {
		return gen.Lesson{}, false, err
	}
	for _, m := range modules {
		if m.Title != moduleTitle {
			continue
		}
		lessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
			return q.ListLessons(ctx, gen.ListLessonsParams{ModuleID: m.ID, Limit: 200, Offset: 0})
		})
		if err != nil {
			return gen.Lesson{}, false, err
		}
		for _, l := range lessons {
			if l.Title == lessonTitle {
				return l, true, nil
			}
		}
	}
	return gen.Lesson{}, false, nil
}

func (s *SeederSvc) courseIDByTitle(ctx context.Context, orgID pgtype.UUID, title string) (pgtype.UUID, bool, error) {
	courses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
		return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: orgID, Limit: 500, Offset: 0})
	})
	if err != nil {
		return pgtype.UUID{}, false, err
	}
	for _, c := range courses {
		if c.Title == title {
			return c.ID, true, nil
		}
	}
	return pgtype.UUID{}, false, nil
}

// seedMLDenseAttempts generates a diverse cohort of attempts for the ML demo
// course, all submitted through the real flow. Deterministic + idempotent.
func (s *SeederSvc) seedMLDenseAttempts(ctx context.Context, interactionsSvc *interactions.InteractionsSvc, aiSvc *ai.AISvc) error {
	org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.GetOrganizationBySlug(ctx, mlOrgSlug)
	})
	if err != nil {
		s.log.InfoContext(ctx, "seed: ML dense attempts skipped — org not found", "org", mlOrgSlug)
		return nil
	}
	courseID, ok, err := s.courseIDByTitle(ctx, org.ID, mlCourseTitle)
	if err != nil {
		return err
	}
	if !ok {
		s.log.InfoContext(ctx, "seed: ML dense attempts skipped — course not found", "course", mlCourseTitle)
		return nil
	}

	members, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListCourseMembersRow, error) {
		return q.ListCourseMembers(ctx, gen.ListCourseMembersParams{CourseID: courseID, Limit: 500, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("list ML members: %w", err)
	}
	students := make([]gen.ListCourseMembersRow, 0, len(members))
	for _, m := range members {
		if m.Role == gen.CourseRoleStudent {
			students = append(students, m)
		}
	}
	sort.Slice(students, func(i, j int) bool { return students[i].UserEmail < students[j].UserEmail })
	if len(students) == 0 {
		s.log.InfoContext(ctx, "seed: ML dense attempts skipped — no student members")
		return nil
	}

	lessons, err := s.loadMLLessons(ctx, courseID)
	if err != nil {
		return err
	}
	if len(lessons) == 0 {
		s.log.InfoContext(ctx, "seed: ML dense attempts skipped — no analyzed lessons")
		return nil
	}

	submitted, failed := 0, 0
	for si, st := range students {
		tier := attemptTiers[si%len(attemptTiers)]
		nLessons := min(max(int(float64(len(lessons))*tier.completion+0.5), 1), len(lessons))
		for li := 0; li < nLessons; li++ {
			lesson := lessons[li]
			if len(lesson.mcqs) == 0 {
				continue
			}
			lessonDiff := 0.010 * float64(li)
			watch := clampF(tier.watch+(detFrac("w", st.UserEmail, lesson.idStr)-0.5)*0.18, 0.05, 1.0)
			responses := make([]*richterv1.AttemptResponseInput, 0, len(lesson.mcqs))
			for _, mc := range lesson.mcqs {
				hardPen := 0.0
				if detFrac("hard", mc.idStr) < 0.20 { // ~20% of chunks are systematically hard → heatmap gaps
					hardPen = 0.20
				}
				p := clampF(tier.accuracy-lessonDiff-hardPen+(detFrac("a", st.UserEmail, mc.idStr)-0.5)*0.10, 0.04, 0.97)
				selected := mc.correct
				if detFrac("ans", st.UserEmail, mc.idStr) >= p {
					selected = wrongOption(mc, st.UserEmail)
				}
				responses = append(responses, mcqResponse(st.UserEmail, mc.idStr, mc.id, selected))
			}
			if err := s.submitAttemptViaFlow(ctx, interactionsSvc, aiSvc, st.UserID, lesson.id, lesson.duration, responses, watch); err != nil {
				failed++
				if failed <= 5 {
					s.log.WarnContext(ctx, "seed: ML attempt failed", "user", st.UserEmail, "lesson", lesson.idStr, "err", err)
				}
				continue
			}
			submitted++
		}
	}
	s.log.InfoContext(ctx, "seed: ML dense attempts done", "students", len(students), "lessons", len(lessons), "submitted", submitted, "failed", failed)
	if submitted == 0 && failed > 0 {
		return fmt.Errorf("all %d ML attempts failed (flow broken)", failed)
	}
	return nil
}

// wrongOption deterministically picks an incorrect option index for an MCQ.
func wrongOption(mc mcqInfo, email string) int {
	wrongs := make([]int, 0, mc.nopts)
	for o := 0; o < mc.nopts; o++ {
		if o != mc.correct {
			wrongs = append(wrongs, o)
		}
	}
	if len(wrongs) == 0 {
		return mc.correct
	}
	return wrongs[int(detFrac("wrong", email, mc.idStr)*float64(len(wrongs)))%len(wrongs)]
}

// loadMLLessons returns the ML course lessons in module/lesson order, each with
// its gradable MCQ interactions.
func (s *SeederSvc) loadMLLessons(ctx context.Context, courseID pgtype.UUID) ([]lessonInfo, error) {
	modules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
		return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: courseID, Limit: 500, Offset: 0})
	})
	if err != nil {
		return nil, fmt.Errorf("list modules: %w", err)
	}
	sort.Slice(modules, func(i, j int) bool { return modules[i].OrderIndex < modules[j].OrderIndex })

	var out []lessonInfo
	for _, m := range modules {
		lessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
			return q.ListLessons(ctx, gen.ListLessonsParams{ModuleID: m.ID, Limit: 500, Offset: 0})
		})
		if err != nil {
			return nil, fmt.Errorf("list lessons: %w", err)
		}
		sort.Slice(lessons, func(i, j int) bool { return lessons[i].OrderIndex < lessons[j].OrderIndex })
		for _, l := range lessons {
			its, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
				return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: l.ID, Limit: 500, Offset: 0})
			})
			if err != nil {
				return nil, fmt.Errorf("list interactions: %w", err)
			}
			li := lessonInfo{id: l.ID, idStr: uuidStr(l.ID), duration: durationSecs(l)}
			for _, it := range its {
				if !mcqKinds[it.Kind] {
					continue
				}
				if correct, nopts, ok := parseMCQ(it.Config); ok {
					li.mcqs = append(li.mcqs, mcqInfo{id: it.ID, idStr: uuidStr(it.ID), correct: correct, nopts: nopts})
				}
			}
			out = append(out, li)
		}
	}
	return out, nil
}
