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

// SeedAdmin seeds the system admin account. Idempotent — safe to call repeatedly.
func (s *SeederSvc) SeedAdmin(ctx context.Context) error {
	s.log.InfoContext(ctx, "seed: running seeder", "name", "admin")
	return s.seedAdmin(ctx)
}

// SeedDev seeds the full dev dataset (users, orgs, members, courses).
// Idempotent — safe to call repeatedly.
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
	Title       string `json:"title"`
	Description string `json:"description"`
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
	// Cache org lookups and existing course titles per org to avoid repeated queries.
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
				if _, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
					return q.CreateLesson(ctx, gen.CreateLessonParams{
						ModuleID:    module.ID,
						Title:       l.Title,
						Description: devDescToPgText(l.Description),
						OrderIndex:  int32(j),
					})
				}); err != nil {
					return fmt.Errorf("create lesson %d %q in module %q: %w", j, l.Title, m.Title, err)
				}
			}
		}
		oc.titles[c.Title] = struct{}{}
		s.log.InfoContext(ctx, "seed: dev course created", "org", c.OrgSlug, "title", c.Title,
			"modules", len(c.Modules))
	}
	return nil
}

func devDescToPgText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
}
