package seed

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

//go:embed data/dev.json
var devDataRaw []byte

var Package = do.Package(
	do.Lazy(NewSeederSvc),
)

func init() {
	Package(internal.Injector)
}

// ── service ───────────────────────────────────────────────────────────────────

type SeederSvc struct {
	pg      *db.PostgresSvc
	log     *log.LogSvc
	admin   *cfg.AdminCfg
	seedCfg *cfg.SeedCfg
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
	s.seedCfg, err = do.Invoke[*cfg.SeedCfg](i)
	if err != nil {
		return nil, fmt.Errorf("SeedCfg cannot be invoked: %w", err)
	}
	return
}

// isDuplicate reports whether err is a PostgreSQL unique-constraint violation.
func isDuplicate(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ── orchestration ─────────────────────────────────────────────────────────────

// seeder is a named unit of seed work. Adding new seed categories = append here.
type seeder struct {
	name string
	run  func(ctx context.Context) error
}

// Seed always seeds the system admin account, then runs dev seeders when
// dev_seed_enabled = true. Every seeder is idempotent — safe to run on startup.
func (s *SeederSvc) Seed(ctx context.Context) error {
	seeders := []seeder{
		{"admin", s.seedAdmin},
	}

	if s.seedCfg.DevSeedEnabled {
		data, err := parseDevData()
		if err != nil {
			return fmt.Errorf("parse dev seed data: %w", err)
		}
		seeders = append(seeders,
			seeder{"dev.users", func(ctx context.Context) error {
				return s.seedDevUsers(ctx, data.Users)
			}},
			seeder{"dev.organizations", func(ctx context.Context) error {
				return s.seedDevOrganizations(ctx, data.Organizations)
			}},
			seeder{"dev.org_members", func(ctx context.Context) error {
				return s.seedDevOrgMembers(ctx, data.OrgMembers)
			}},
		)
	}

	for _, sd := range seeders {
		s.log.InfoContext(ctx, "seed: running seeder", "name", sd.name)
		if err := sd.run(ctx); err != nil {
			return fmt.Errorf("seeder %q: %w", sd.name, err)
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
	Users         []devUserSpec      `json:"users"`
	Organizations []devOrgSpec       `json:"organizations"`
	OrgMembers    []devOrgMemberSpec `json:"org_members"`
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

func parseDevData() (devSeedData, error) {
	var data devSeedData
	if err := json.Unmarshal(devDataRaw, &data); err != nil {
		return devSeedData{}, fmt.Errorf("unmarshal dev.json: %w", err)
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
			return fmt.Errorf("add member %s to %s: %w", m.UserEmail, m.OrgSlug, err)
		}
		s.log.InfoContext(ctx, "seed: dev org member added", "org", m.OrgSlug, "user", m.UserEmail)
	}
	return nil
}
