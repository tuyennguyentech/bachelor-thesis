package seed

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
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
	pg       *db.PostgresSvc
	kv       *kv.KVSvc
	log      *log.LogSvc
	admin    *cfg.AdminCfg
	s3client *minio.Client
	s3cfg    *cfg.S3Cfg
}

func NewSeederSvc(i do.Injector) (s *SeederSvc, err error) {
	s = new(SeederSvc)
	s.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	s.kv, err = do.Invoke[*kv.KVSvc](i)
	if err != nil {
		return nil, fmt.Errorf("KVSvc cannot be invoked: %w", err)
	}
	s.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	s.admin, err = do.Invoke[*cfg.AdminCfg](i)
	if err != nil {
		return nil, fmt.Errorf("AdminCfg cannot be invoked: %w", err)
	}
	s.s3cfg, err = do.Invoke[*cfg.S3Cfg](i)
	if err != nil {
		return nil, fmt.Errorf("S3Cfg cannot be invoked: %w", err)
	}
	s.s3client, err = minio.New(s.s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s.s3cfg.AccessKeyID, s.s3cfg.SecretAccessKey, ""),
		Secure: s.s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client init: %w", err)
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
		{"dev.lesson_video_keys", func(ctx context.Context) error { return s.seedDevLessonVideoKeys(ctx, data.Courses) }},
		{"dev.quiz_attempts", func(ctx context.Context) error { return s.seedDevQuizAttempts(ctx, data.QuizAttempts) }},
		{"dev.videos", func(ctx context.Context) error { return s.seedDevVideos(ctx, data.Videos) }},
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
	Videos        []devVideoSpec
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
	Title        string           `json:"title"`
	Description  string           `json:"description"`
	Analysis     *devAnalysisSpec `json:"analysis,omitempty"`
	VideoKey     string           `json:"video_key,omitempty"`
	DurationSecs int32            `json:"duration_secs,omitempty"`
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
	StartSeconds  float64  `json:"start_seconds"`
}

type devVideoSpec struct {
	LocalPath string `json:"local_path"`
	S3Key     string `json:"s3_key"`
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
	if err := readDevJSON("data/dev/videos.json", &data.Videos); err != nil {
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

func (s *SeederSvc) seedLessonAnalysis(ctx context.Context, lessonID pgtype.UUID, a *devAnalysisSpec) error {
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   gen.LessonAnalysisStatusDone,
			ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return fmt.Errorf("upsert analysis: %w", err)
	}
	if a.Transcript != "" {
		if err := s.kv.Set("lesson", tuple.Tuple{lessonID.String(), "transcript"}, []byte(a.Transcript)); err != nil {
			s.log.WarnContext(ctx, "seed: FDB transcript write failed", "lesson_id", lessonID.String(), "err", err)
		}
	}

	// Delete old questions, then insert fresh ones
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonQuestions(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete old questions: %w", err)
	}

	for i, qspec := range a.Questions {
		optJSON, err := json.Marshal(qspec.Options)
		if err != nil {
			return fmt.Errorf("marshal options for question %d: %w", i, err)
		}
		if _, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonQuestion, error) {
			return q.CreateLessonQuestion(ctx, gen.CreateLessonQuestionParams{
				LessonID:      lessonID,
				QuestionText:  qspec.QuestionText,
				Options:       optJSON,
				CorrectAnswer: qspec.CorrectAnswer,
				Explanation:   pgtype.Text{String: qspec.Explanation, Valid: qspec.Explanation != ""},
				OrderIndex:    int32(i),
				StartSeconds:  qspec.StartSeconds,
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
			return q.ListLessonQuestions(ctx, gen.ListLessonQuestionsParams{
				LessonID: lessonID,
				Limit:    100,
				Offset:   0,
			})
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

		answersJSON, err := json.Marshal(a.Answers)
		if err != nil {
			return fmt.Errorf("marshal answers for attempt %s/%s: %w", a.UserEmail, a.LessonTitle, err)
		}
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

// ── video seeder ──────────────────────────────────────────────────────────────

func (s *SeederSvc) ensureBucket(ctx context.Context) error {
	exists, err := s.s3client.BucketExists(ctx, s.s3cfg.Bucket)
	if err != nil {
		return fmt.Errorf("check bucket %q: %w", s.s3cfg.Bucket, err)
	}
	if !exists {
		if err := s.s3client.MakeBucket(ctx, s.s3cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			return fmt.Errorf("create bucket %q: %w", s.s3cfg.Bucket, err)
		}
		s.log.InfoContext(ctx, "seed: bucket created", "bucket", s.s3cfg.Bucket)
	}
	return nil
}

func (s *SeederSvc) seedDevVideos(ctx context.Context, videos []devVideoSpec) error {
	if err := s.ensureBucket(ctx); err != nil {
		return err
	}
	for _, v := range videos {
		if _, err := s.s3client.StatObject(ctx, s.s3cfg.Bucket, v.S3Key, minio.StatObjectOptions{}); err == nil {
			s.log.InfoContext(ctx, "seed: video already in storage, skipping", "key", v.S3Key)
			continue
		}
		s.log.InfoContext(ctx, "seed: uploading video", "key", v.S3Key, "file", v.LocalPath)
		if err := s.uploadFromFile(ctx, v.S3Key, v.LocalPath); err != nil {
			s.log.WarnContext(ctx, "seed: video upload failed, continuing", "key", v.S3Key, "err", err)
			continue
		}
		s.log.InfoContext(ctx, "seed: video uploaded", "key", v.S3Key)
	}
	return nil
}

func (s *SeederSvc) uploadFromFile(ctx context.Context, s3Key, localPath string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", localPath, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", localPath, err)
	}

	_, putErr := s.s3client.PutObject(ctx, s.s3cfg.Bucket, s3Key, f, info.Size(), minio.PutObjectOptions{
		ContentType: "video/mp4",
	})
	if putErr == nil {
		return nil
	}

	// Fall back to presigned PUT — works for buckets that reject header-based auth
	// (e.g. SeaweedFS buckets configured without IAM accept presigned requests).
	presignURL, err := s.s3client.PresignedPutObject(ctx, s.s3cfg.Bucket, s3Key, 15*time.Minute)
	if err != nil {
		return fmt.Errorf("direct upload failed (%v); presign also failed: %w", putErr, err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, presignURL.String(), f)
	if err != nil {
		return fmt.Errorf("build presigned PUT request: %w", err)
	}
	req.ContentLength = info.Size()
	req.Header.Set("Content-Type", "video/mp4")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("presigned PUT: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("presigned PUT: status %d: %s", resp.StatusCode, string(body))
	}
	return nil
}
