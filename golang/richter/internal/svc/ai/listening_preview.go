package ai

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
)

// PreviewListeningAudio synthesises a listening question's text to audio so the
// teacher can hear it WHILE editing (before saving). It uploads to a temporary
// lesson-scoped key and returns that key; the client fetches a browser-reachable
// URL via StorageService.GetDownloadUrl. It does NOT touch any interaction config.
func (s *AISvc) PreviewListeningAudio(
	ctx context.Context,
	req *richterv1.PreviewListeningAudioRequest,
) (*richterv1.PreviewListeningAudioResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}
	text := strings.TrimSpace(req.GetText())
	if text == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("listening preview: text required"))
	}

	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	wav, err := s.synthesiseWithRetry(ctx, normalizeForTTS(text, lesson.Language), lesson.Language)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listening preview: synthesise: %w", err))
	}

	// Lesson-scoped key so StorageSvc.orgIDForKey can authorise the download.
	key := "lessons/" + lessonID.String() + "/ai-audio-preview/" + uuid.New().String() + ".wav"
	if _, err := s.s3client.PutObject(ctx, s.s3cfg.Bucket, key, bytes.NewReader(wav), int64(len(wav)), minio.PutObjectOptions{
		ContentType: "audio/wav",
	}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listening preview: upload: %w", err))
	}

	return &richterv1.PreviewListeningAudioResponse{AudioObjectKey: key}, nil
}
