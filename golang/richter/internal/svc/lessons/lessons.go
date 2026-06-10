package lessons

import (
	"fmt"
	"net/http"
	"path"
	"strings"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/log"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewLessonsSvc),
)

func init() {
	Package(internal.Injector)
}

type LessonsSvc struct {
	pg       *db.PostgresSvc
	kv       *kv.KVSvc
	log      *log.LogSvc
	authz    *authz.AuthzSvc
	s3client *minio.Client
	s3cfg    *cfg.S3Cfg
	lessCfg  *cfg.LessonsCfg
}

func validateLessonVideoKey(lessonID string, key string) error {
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("video storage key is required")
	}
	if cleaned := path.Clean(key); cleaned != key {
		return fmt.Errorf("video storage key contains invalid path components")
	}
	if strings.HasPrefix(key, "/") || strings.Contains(key, "..") {
		return fmt.Errorf("video storage key must not be absolute or contain ..")
	}
	prefix := "lessons/" + lessonID + "/"
	if !strings.HasPrefix(key, prefix) {
		return fmt.Errorf("video storage key must belong to the lesson")
	}
	rest := strings.TrimPrefix(key, prefix)
	if rest == "" {
		return fmt.Errorf("video storage key must include a filename")
	}
	if rest == "video" || strings.HasPrefix(rest, "video/") || strings.HasPrefix(rest, "video.") {
		return nil
	}
	return fmt.Errorf("video storage key must be under the lesson video path")
}

var _ richterv1connect.LessonServiceHandler = (*LessonsSvc)(nil)

func NewLessonsSvc(i do.Injector) (s *LessonsSvc, err error) {
	s = new(LessonsSvc)
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
	s.authz, err = do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	s.s3cfg, err = do.Invoke[*cfg.S3Cfg](i)
	if err != nil {
		return nil, fmt.Errorf("S3Cfg cannot be invoked: %w", err)
	}
	s.lessCfg, err = do.Invoke[*cfg.LessonsCfg](i)
	if err != nil {
		return nil, fmt.Errorf("LessonsCfg cannot be invoked: %w", err)
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

func (s *LessonsSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewLessonServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

func descToPgText(desc string) pgtype.Text {
	return pgtype.Text{String: desc, Valid: desc != ""}
}
