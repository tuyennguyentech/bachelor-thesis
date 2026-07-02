package seed

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
)

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
		// A MISSING local source is only tolerated for ML playlist videos (an EXTERNAL
		// dependency the operator downloads separately) → warn + continue + fixtures.
		// Committed demo clips missing, or a genuine storage failure, are real errors → STOP.
		if _, statErr := os.Stat(v.LocalPath); statErr != nil {
			if strings.Contains(filepath.ToSlash(v.LocalPath), "/ml/") {
				s.log.WarnContext(ctx, "seed: ML playlist video not downloaded, skipping upload (golden fixtures used)",
					"key", v.S3Key, "file", v.LocalPath)
				continue
			}
			return fmt.Errorf("seed: committed video source missing %q: %w", v.LocalPath, statErr)
		}
		s.log.InfoContext(ctx, "seed: uploading video", "key", v.S3Key, "file", v.LocalPath)
		if err := s.uploadFromFile(ctx, v.S3Key, v.LocalPath); err != nil {
			return fmt.Errorf("seed: upload video %q: %w", v.S3Key, err)
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
	resp, err := seedHTTPClient.Do(req)
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
