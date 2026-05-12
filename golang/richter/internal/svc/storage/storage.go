package storage

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
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

	client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio client init: %w", err)
	}

	return &StorageSvc{client: client, cfg: s3cfg, authz: az}, nil
}

func (s *StorageSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewStorageServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

func (s *StorageSvc) GetUploadUrl(
	ctx context.Context,
	req *richterv1.GetUploadUrlRequest,
) (*richterv1.GetUploadUrlResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
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

	// Rewrite internal endpoint to public-accessible URL if different.
	uploadURL := u.String()
	if s.cfg.PublicEndpoint != "" && s.cfg.Endpoint != "" {
		// Swap scheme+host portion to PublicEndpoint.
		internalPrefix := "http://" + s.cfg.Endpoint
		if s.cfg.UseSSL {
			internalPrefix = "https://" + s.cfg.Endpoint
		}
		if len(uploadURL) > len(internalPrefix) && uploadURL[:len(internalPrefix)] == internalPrefix {
			uploadURL = s.cfg.PublicEndpoint + uploadURL[len(internalPrefix):]
		}
	}

	return &richterv1.GetUploadUrlResponse{UploadUrl: uploadURL, Key: req.GetKey()}, nil
}

func (s *StorageSvc) GetDownloadUrl(
	ctx context.Context,
	req *richterv1.GetDownloadUrlRequest,
) (*richterv1.GetDownloadUrlResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
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

	downloadURL := u.String()
	if s.cfg.PublicEndpoint != "" && s.cfg.Endpoint != "" {
		internalPrefix := "http://" + s.cfg.Endpoint
		if s.cfg.UseSSL {
			internalPrefix = "https://" + s.cfg.Endpoint
		}
		if len(downloadURL) > len(internalPrefix) && downloadURL[:len(internalPrefix)] == internalPrefix {
			downloadURL = s.cfg.PublicEndpoint + downloadURL[len(internalPrefix):]
		}
	}

	return &richterv1.GetDownloadUrlResponse{DownloadUrl: downloadURL}, nil
}
