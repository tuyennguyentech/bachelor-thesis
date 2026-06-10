package seed

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/log"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

//go:embed data/dev
var devDataFS embed.FS

// seedHTTPClient is used for presigned upload requests — 10 minute timeout to
// handle large seed video files without blocking indefinitely on hung connections.
var seedHTTPClient = &http.Client{Timeout: 10 * time.Minute}

var Package = do.Package(
	do.Lazy(NewSeederSvc),
)

func init() {
	Package(internal.Injector)
}

// SeederSvc is the entry point for the seed CLI command and the dev-data
// pipeline. Each domain (admin, users, orgs, courses, attempts, videos)
// lives in its own file alongside this one.
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

func devDescToPgText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
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

// SeedAdmin runs the production-only admin seeder (idempotent).
func (s *SeederSvc) SeedAdmin(ctx context.Context) error {
	s.log.InfoContext(ctx, "seed: running seeder", "name", "admin")
	return s.seedAdmin(ctx)
}

// SeedDev runs the full dev-data pipeline. Steps are run sequentially; any
// step failure aborts the run and is reported with the step name.
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
		{"dev.attempts", func(ctx context.Context) error { return s.seedDevAttempts(ctx, data.Attempts) }},
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
