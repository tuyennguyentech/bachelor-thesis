package seed

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

//go:embed data/dev
var devDataFS embed.FS

var Package = do.Package(
	do.Lazy(NewSeederSvc),
)

func init() {
	Package(internal.Injector)
}

// ── service ───────────────────────────────────────────────────────────────────

type SeederSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	admin *cfg.AdminCfg
}

func NewSeederSvc(i do.Injector) (s *SeederSvc, err error) {
	s = new(SeederSvc)
	s.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	s.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	s.admin, err = do.Invoke[*cfg.AdminCfg](i)
	if err != nil {
		return nil, fmt.Errorf("AdminCfg cannot be invoked: %w", err)
	}
	return
}

// isDuplicate reports whether err is a PostgreSQL unique-constraint violation.
func isDuplicate(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ── orchestration ─────────────────────────────────────────────────────────────

func (s *SeederSvc) SeedAdmin(ctx context.Context) error {
	s.log.InfoContext(ctx, "seed: running seeder", "name", "admin")
	return s.seedAdmin(ctx)
}

func (s *SeederSvc) SeedDev(ctx context.Context) error {
	data, err := parseDevData()
	if err != nil {
		return fmt.Errorf("parse dev seed data: %w", err)
	}
	type step struct {
		name string
		run  func(context.Context) error
	}
	steps := []step{
		{"dev.users", func(ctx context.Context) error { return s.seedDevUsers(ctx, data.Users) }},
		{"dev.organizations", func(ctx context.Context) error { return s.seedDevOrganizations(ctx, data.Organizations) }},
		{"dev.org_members", func(ctx context.Context) error { return s.seedDevOrgMembers(ctx, data.OrgMembers) }},
		{"dev.courses", func(ctx context.Context) error { return s.seedDevCourses(ctx, data.Courses) }},
		{"dev.quiz_attempts", func(ctx context.Context) error { return s.seedDevQuizAttempts(ctx, data.QuizAttempts) }},
	}
	for _, st := range steps {
		s.log.InfoContext(ctx, "seed: running seeder", "name", st.name)
		if err := st.run(ctx); err != nil {
			return fmt.Errorf("seeder %q: %w", st.name, err)
		}
	}
	return nil
}

// ── admin seeder ──────────────────────────────────────────────────────────────

func (s *SeederSvc) seedAdmin(ctx context.Context) error {
	hash, err := secure.HashPassword(s.admin.Password)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}
	_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.CreateUserWithRoleAndStatus(ctx, gen.CreateUserWithRoleAndStatusParams{
			Email:        s.admin.Email,
			PasswordHash: hash,
			FirstName:    s.admin.FirstName,
			LastName:     s.admin.LastName,
			MiddleName:   svc.OptionalStringToPgText(nil),
			Role:         gen.UserRoleAdmin,
			Status:       gen.UserStatusActive,
		})
	})
	if isDuplicate(err) {
		s.log.InfoContext(ctx, "seed: admin already exists, skipping")
		return nil
	}
	if err != nil {
		return fmt.Errorf("create admin: %w", err)
	}
	s.log.InfoContext(ctx, "seed: admin created", "email", s.admin.Email)
	return nil
}

// ── dev seed data types ───────────────────────────────────────────────────────

type devSeedData struct {
	Users         []devUserSpec
	Organizations []devOrgSpec
	OrgMembers    []devOrgMemberSpec
	Courses       []devCourseSpec
	QuizAttempts  []devQuizAttemptSpec
}

type devUserSpec struct {
	Email     string `json:"email"`
	Password  string `json:"password"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Role      string `json:"role"`
	Status    string `json:"status"`
}

type devOrgSpec struct {
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	CreatorEmail string `json:"creator_email"`
}

type devOrgMemberSpec struct {
	OrgSlug   string `json:"org_slug"`
	UserEmail string `json:"user_email"`
	Role      string `json:"role"`
	Status    string `json:"status"`
}

type devCourseSpec struct {
	OrgSlug     string          `json:"org_slug"`
	OwnerEmail  string          `json:"owner_email"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Status      string          `json:"status"`
	Modules     []devModuleSpec `json:"modules"`
}

type devModuleSpec struct {
	Title   string          `json:"title"`
	Lessons []devLessonSpec `json:"lessons"`
}

type devLessonSpec struct {
	Title       string           `json:"title"`
	Description string           `json:"description"`
	Analysis    *devAnalysisSpec `json:"analysis,omitempty"`
}

type devAnalysisSpec struct {
	Transcript string            `json:"transcript"`
	Questions  []devQuestionSpec `json:"questions"`
}

type devQuestionSpec struct {
	QuestionText  string   `json:"question_text"`
	Options       []string `json:"options"`
	CorrectAnswer int32    `json:"correct_answer"`
	Explanation   string   `json:"explanation"`
}

type devQuizAttemptSpec struct {
	UserEmail   string  `json:"user_email"`
	OrgSlug     string  `json:"org_slug"`
	CourseTitle string  `json:"course_title"`
	ModuleTitle string  `json:"module_title"`
	LessonTitle string  `json:"lesson_title"`
	Answers     []int32 `json:"answers"`
}

func readDevJSON(path string, v any) error {
	raw, err := devDataFS.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("unmarshal %s: %w", path, err)
	}
	return nil
}

func parseDevData() (devSeedData, error) {
	var data devSeedData
	if err := readDevJSON("data/dev/users.json", &data.Users); err != nil {
		return devSeedData{}, err
	}
	if err := readDevJSON("data/dev/organizations.json", &data.Organizations); err != nil {
		return devSeedData{}, err
	}
	if err := readDevJSON("data/dev/org_members.json", &data.OrgMembers); err != nil {
		return devSeedData{}, err
	}
	entries, err := devDataFS.ReadDir("data/dev/courses")
	if err != nil {
		return devSeedData{}, fmt.Errorf("read courses dir: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var courses []devCourseSpec
		if err := readDevJSON("data/dev/courses/"+entry.Name(), &courses); err != nil {
			return devSeedData{}, err
		}
		data.Courses = append(data.Courses, courses...)
	}
	if err := readDevJSON("data/dev/quiz_attempts.json", &data.QuizAttempts); err != nil {
		return devSeedData{}, err
	}
	return data, nil
}

// ── dev seeders ───────────────────────────────────────────────────────────────

func (s *SeederSvc) seedDevUsers(ctx context.Context, users []devUserSpec) error {
	for _, u := range users {
		hash, err := secure.HashPassword(u.Password)
		if err != nil {
			return fmt.Errorf("hash password for %s: %w", u.Email, err)
		}
		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.CreateUserWithRoleAndStatus(ctx, gen.CreateUserWithRoleAndStatusParams{
				Email:        u.Email,
				PasswordHash: hash,
				FirstName:    u.FirstName,
				LastName:     u.LastName,
				MiddleName:   svc.OptionalStringToPgText(nil),
				Role:         gen.UserRole(u.Role),
				Status:       gen.UserStatus(u.Status),
			})
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev user already exists, skipping", "email", u.Email)
			continue
		}
		if err != nil {
			return fmt.Errorf("create user %s: %w", u.Email, err)
		}
		s.log.InfoContext(ctx, "seed: dev user created", "email", u.Email)
	}
	return nil
}

func (s *SeederSvc) seedDevOrganizations(ctx context.Context, orgs []devOrgSpec) error {
	for _, o := range orgs {
		creator, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, o.CreatorEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup creator %s for org %s: %w", o.CreatorEmail, o.Slug, err)
		}

		_, err = db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.Organization, error) {
			org, err := q.CreateOrganization(ctx, gen.CreateOrganizationParams{
				CreatedBy: creator.ID,
				Name:      o.Name,
				Slug:      o.Slug,
			})
			if err != nil {
				return gen.Organization{}, err
			}
			_, err = q.AddOrganizationMember(ctx, gen.AddOrganizationMemberParams{
				OrganizationID: org.ID,
				UserID:         creator.ID,
				Role:           gen.OrganizationRoleOwner,
				Status:         gen.MemberStatusActive,
			})
			return org, err
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev org already exists, skipping", "slug", o.Slug)
			continue
		}
		if err != nil {
			return fmt.Errorf("create org %s: %w", o.Slug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org created", "slug", o.Slug)
	}
	return nil
}

func (s *SeederSvc) seedDevOrgMembers(ctx context.Context, members []devOrgMemberSpec) error {
	for _, m := range members {
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, m.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", m.OrgSlug, err)
		}

		user, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, m.UserEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup user %s: %w", m.UserEmail, err)
		}

		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
			return q.AddOrganizationMember(ctx, gen.AddOrganizationMemberParams{
				OrganizationID: org.ID,
				UserID:         user.ID,
				Role:           gen.OrganizationRole(m.Role),
				Status:         gen.MemberStatus(m.Status),
			})
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev org member already exists, skipping", "org", m.OrgSlug, "user", m.UserEmail)
			continue
		}
		if err != nil {
			return fmt.Errorf("create member %s in %s: %w", m.UserEmail, m.OrgSlug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org member created", "org", m.OrgSlug, "user", m.UserEmail)
	}
	return nil
}

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

				if l.Analysis != nil {
					if err := s.seedLessonAnalysis(ctx, lesson.ID, l.Analysis); err != nil {
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

func (s *SeederSvc) seedLessonAnalysis(ctx context.Context, lessonID pgtype.UUID, a *devAnalysisSpec) error {
	analysis, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
		return q.UpsertLessonAnalysis(ctx, gen.UpsertLessonAnalysisParams{
			LessonID:   lessonID,
			Status:     gen.LessonAnalysisStatusDone,
			Transcript: pgtype.Text{String: a.Transcript, Valid: true},
			ErrorMsg:   pgtype.Text{},
		})
	})
	if err != nil {
		return fmt.Errorf("upsert analysis: %w", err)
	}
	_ = analysis

	// Delete old questions, then insert fresh ones
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonQuestions(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete old questions: %w", err)
	}

	for i, qspec := range a.Questions {
		optJSON, _ := json.Marshal(qspec.Options)
		if _, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonQuestion, error) {
			return q.CreateLessonQuestion(ctx, gen.CreateLessonQuestionParams{
				LessonID:      lessonID,
				QuestionText:  qspec.QuestionText,
				Options:       optJSON,
				CorrectAnswer: qspec.CorrectAnswer,
				Explanation:   pgtype.Text{String: qspec.Explanation, Valid: qspec.Explanation != ""},
				OrderIndex:    int32(i),
			})
		}); err != nil {
			return fmt.Errorf("create question %d: %w", i, err)
		}
	}
	return nil
}

// seedDevQuizAttempts seeds quiz attempt records for dev users.
// It looks up lessons by path (org→course→module→lesson) to get the lesson ID.
func (s *SeederSvc) seedDevQuizAttempts(ctx context.Context, attempts []devQuizAttemptSpec) error {
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
			s.log.InfoContext(ctx, "seed: quiz attempt skipped — course not found", "course", a.CourseTitle)
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
			s.log.InfoContext(ctx, "seed: quiz attempt skipped — module not found", "module", a.ModuleTitle)
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
			s.log.InfoContext(ctx, "seed: quiz attempt skipped — lesson not found", "lesson", a.LessonTitle)
			continue
		}

		// Load questions to compute score
		questions, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonQuestion, error) {
			return q.ListLessonQuestions(ctx, lessonID)
		})
		if err != nil || len(questions) == 0 {
			s.log.InfoContext(ctx, "seed: quiz attempt skipped — no questions for lesson", "lesson", a.LessonTitle)
			continue
		}

		score := int32(0)
		total := int32(len(questions))
		for i, q := range questions {
			if i < len(a.Answers) && a.Answers[i] == q.CorrectAnswer {
				score++
			}
		}

		answersJSON, _ := json.Marshal(a.Answers)
		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.QuizAttempt, error) {
			return q.UpsertQuizAttempt(ctx, gen.UpsertQuizAttemptParams{
				LessonID: lessonID,
				UserID:   user.ID,
				Answers:  answersJSON,
				Score:    score,
				Total:    total,
			})
		})
		if err != nil {
			return fmt.Errorf("upsert quiz attempt %s/%s: %w", a.UserEmail, a.LessonTitle, err)
		}
		s.log.InfoContext(ctx, "seed: quiz attempt seeded", "user", a.UserEmail, "lesson", a.LessonTitle, "score", fmt.Sprintf("%d/%d", score, total))
	}
	return nil
}

func devDescToPgText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
}
