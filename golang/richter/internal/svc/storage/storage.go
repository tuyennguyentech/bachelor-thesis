package storage

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewStorageSvc),
)

func init() {
	Package(internal.Injector)
}

type StorageSvc struct {
	client *minio.Client
	cfg    *cfg.S3Cfg
	authz  *authz.AuthzSvc
	pg     *db.PostgresSvc
}

var _ richterv1connect.StorageServiceHandler = (*StorageSvc)(nil)

func NewStorageSvc(i do.Injector) (*StorageSvc, error) {
	s3cfg, err := do.Invoke[*cfg.S3Cfg](i)
	if err != nil {
		return nil, fmt.Errorf("S3Cfg cannot be invoked: %w", err)
	}
	az, err := do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	pg, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}

	client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client init: %w", err)
	}

	return &StorageSvc{client: client, cfg: s3cfg, authz: az, pg: pg}, nil
}

func (s *StorageSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewStorageServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

// validateLessonKey ensures key is in the form lessons/<uuid>/... and returns the
// lesson UUID string. Rejects path traversal and other malformed keys.
func validateLessonKey(key string) (lessonID string, err error) {
	if cleaned := path.Clean(key); cleaned != key {
		return "", fmt.Errorf("key contains invalid path components")
	}
	if strings.HasPrefix(key, "/") || strings.Contains(key, "..") {
		return "", fmt.Errorf("key must not be absolute or contain ..")
	}
	parts := strings.SplitN(key, "/", 3)
	if len(parts) < 3 || parts[0] != "lessons" || parts[1] == "" || parts[2] == "" {
		return "", fmt.Errorf("key must be in lessons/<id>/<filename> format")
	}
	return parts[1], nil
}

// validateSeedKey ensures key is in the form seed/<org-slug>/... and returns
// the org slug. Used for seeded demo content that doesn't follow the lessons/ path.
func validateSeedKey(key string) (orgSlug string, err error) {
	if cleaned := path.Clean(key); cleaned != key {
		return "", fmt.Errorf("key contains invalid path components")
	}
	if strings.HasPrefix(key, "/") || strings.Contains(key, "..") {
		return "", fmt.Errorf("key must not be absolute or contain ..")
	}
	parts := strings.SplitN(key, "/", 3)
	if len(parts) < 3 || parts[0] != "seed" || parts[1] == "" || parts[2] == "" {
		return "", fmt.Errorf("seed key must be in seed/<org-slug>/<path> format")
	}
	return parts[1], nil
}

func (s *StorageSvc) orgIDForKey(ctx context.Context, key string) (pgtype.UUID, error) {
	if strings.HasPrefix(key, "seed/") {
		orgSlug, err := validateSeedKey(key)
		if err != nil {
			return pgtype.UUID{}, connect.NewError(connect.CodeInvalidArgument, err)
		}
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, orgSlug)
		})
		if err != nil {
			return pgtype.UUID{}, svc.ConnectDBError(err)
		}
		return org.ID, nil
	}
	lessonIDStr, err := validateLessonKey(key)
	if err != nil {
		return pgtype.UUID{}, connect.NewError(connect.CodeInvalidArgument, err)
	}
	lessonID, err := svc.ParseUUID(lessonIDStr)
	if err != nil {
		return pgtype.UUID{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid lesson ID in key"))
	}
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return pgtype.UUID{}, svc.ConnectDBError(err)
	}
	return orgID, nil
}

func (s *StorageSvc) GetUploadUrl(
	ctx context.Context,
	req *richterv1.GetUploadUrlRequest,
) (*richterv1.GetUploadUrlResponse, error) {
	orgID, err := s.orgIDForKey(ctx, req.GetKey())
	if err != nil {
		return nil, err
	}
	// Uploading requires teacher-level access (or higher).
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	expires := time.Duration(req.GetExpiresInSeconds()) * time.Second
	if expires == 0 {
		expires = time.Hour
	}

	u, err := s.client.PresignedPutObject(ctx, s.cfg.Bucket, req.GetKey(), expires)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("presign upload: %w", err))
	}

	return &richterv1.GetUploadUrlResponse{UploadUrl: rewritePresignedURL(u.String(), s.cfg), Key: req.GetKey()}, nil
}

func (s *StorageSvc) GetDownloadUrl(
	ctx context.Context,
	req *richterv1.GetDownloadUrlRequest,
) (*richterv1.GetDownloadUrlResponse, error) {
	orgID, err := s.orgIDForKey(ctx, req.GetKey())
	if err != nil {
		return nil, err
	}
	// Downloading requires being an active org member.
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	expires := time.Duration(req.GetExpiresInSeconds()) * time.Second
	if expires == 0 {
		expires = time.Hour
	}

	u, err := s.client.PresignedGetObject(ctx, s.cfg.Bucket, req.GetKey(), expires, nil)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("presign download: %w", err))
	}

	return &richterv1.GetDownloadUrlResponse{DownloadUrl: rewritePresignedURL(u.String(), s.cfg)}, nil
}

func rewritePresignedURL(raw string, c *cfg.S3Cfg) string {
	if c.PublicEndpoint == "" || c.Endpoint == "" {
		return raw
	}
	scheme := "http://"
	if c.UseSSL {
		scheme = "https://"
	}
	internal := scheme + c.Endpoint
	if strings.HasPrefix(raw, internal) {
		return c.PublicEndpoint + raw[len(internal):]
	}
	return raw
}
