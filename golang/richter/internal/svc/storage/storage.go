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
	"golang.org/x/text/unicode/norm"
)

var Package = do.Package(
	do.Lazy(NewStorageSvc),
)

func init() {
	Package(internal.Injector)
}

type StorageSvc struct {
	client        *minio.Client
	cfg           *cfg.S3Cfg
	authz         *authz.AuthzSvc
	pg            *db.PostgresSvc
	uploadLimiter UploadRateLimiter
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
	storageCfg, err := do.Invoke[*cfg.StorageCfg](i)
	if err != nil {
		return nil, fmt.Errorf("StorageCfg cannot be invoked: %w", err)
	}

	client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client init: %w", err)
	}

	return &StorageSvc{
		client:        client,
		cfg:           s3cfg,
		authz:         az,
		pg:            pg,
		uploadLimiter: NewUploadRateLimiter(*storageCfg),
	}, nil
}

func (s *StorageSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewStorageServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

// allowedLessonAssetExts is the set of file extensions a teacher (or student,
// for recordings) may upload under lessons/<id>/. Anything else is rejected
// to prevent storing arbitrary payloads (executables, scripts, hostile SVG).
var (
	allowedLessonAssetExts = map[string]bool{
		".mp4": true, ".m4v": true, ".webm": true, ".mov": true,
		".wav": true, ".mp3": true, ".ogg": true, ".pdf": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true,
	}
	allowedStudentRecordingExts = map[string]bool{
		".wav": true, ".webm": true, ".ogg": true, ".mp3": true, ".m4a": true,
	}
)

// normalizeStorageKey applies NFC Unicode normalization so attackers cannot
// smuggle look-alike characters (fullwidth slash U+FF0F, etc.) past our
// structural validators.
func normalizeStorageKey(key string) string {
	return norm.NFC.String(key)
}

// validateLessonKey ensures key is in the form lessons/<uuid>/... and returns the
// lesson UUID string. Rejects path traversal, other malformed keys, and any
// file extension outside the allowlist.
func validateLessonKey(key string) (lessonID string, err error) {
	key = normalizeStorageKey(key)
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
	ext := strings.ToLower(path.Ext(key))
	if !allowedLessonAssetExts[ext] {
		return "", fmt.Errorf("file extension %q is not allowed for lesson assets", ext)
	}
	return parts[1], nil
}

// isStudentRecordingKey reports whether the key is a student's own audio
// upload — `lessons/<lessonID>/student-recordings/<filename>`. These uploads
// are writable by any active member of the lesson's organization, not just
// teachers, so students can submit reading-interaction recordings.
func isStudentRecordingKey(key string) bool {
	key = normalizeStorageKey(key)
	parts := strings.SplitN(key, "/", 4)
	if len(parts) != 4 || parts[0] != "lessons" || parts[2] != "student-recordings" {
		return false
	}
	ext := strings.ToLower(path.Ext(parts[3]))
	return allowedStudentRecordingExts[ext]
}

// validateSeedKey ensures key is in the form seed/<org-slug>/... and returns
// the org slug. Used for seeded demo content that doesn't follow the lessons/ path.
func validateSeedKey(key string) (orgSlug string, err error) {
	key = normalizeStorageKey(key)
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
	if s.cfg.PublicEndpoint == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("storage public_endpoint is not configured; contact admin to set the s3.public_endpoint config"))
	}
	orgID, err := s.orgIDForKey(ctx, req.GetKey())
	if err != nil {
		return nil, err
	}
	// Student recordings (audio responses for reading interactions) are uploaded
	// by the learner themselves under `lessons/<id>/student-recordings/...`.
	// Other keys (lesson assets, seeded content) require teacher-level access.
	if isStudentRecordingKey(req.GetKey()) {
		claims, err := s.authz.RequireOrgRole(ctx, orgID,
			gen.OrganizationRoleOwner,
			gen.OrganizationRoleAdmin,
			gen.OrganizationRoleTeacher,
			gen.OrganizationRoleStudent,
		)
		if err != nil {
			return nil, err
		}
		if !s.allowStudentUpload(claims.GetSub(), req.GetKey()) {
			return nil, connect.NewError(connect.CodeResourceExhausted,
				fmt.Errorf("bạn đã tải lên quá nhiều bản ghi trong thời gian ngắn, vui lòng chờ một phút"))
		}
	} else {
		if _, err := s.authz.RequireOrgRole(ctx, orgID,
			gen.OrganizationRoleOwner,
			gen.OrganizationRoleAdmin,
			gen.OrganizationRoleTeacher,
		); err != nil {
			return nil, err
		}
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
	if s.cfg.PublicEndpoint == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("storage public_endpoint is not configured; contact admin to set the s3.public_endpoint config"))
	}
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
	// Callers (GetUploadUrl, GetDownloadUrl) reject requests when PublicEndpoint
	// is empty, so the empty branch below is a defensive fallback only.
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

// allowStudentUpload reports whether a student may issue another presigned
// upload for the given key. Delegates to the swappable UploadRateLimiter
// strategy (in-memory today, FDB/Redis-ready).
func (s *StorageSvc) allowStudentUpload(userID, key string) bool {
	return s.uploadLimiter.Allow(userID, key)
}
