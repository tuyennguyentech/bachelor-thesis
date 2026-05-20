package ai

import (
	"context"
	"fmt"
	"io"
	"time"

	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
)

// buildGradingDeps is the GradingDepsProvider registered in DI.
// It fetches the lesson language from DB and wires the GradeAudio / GetAudioBytes closures.
func (s *AISvc) buildGradingDeps(ctx context.Context, lessonID pgtype.UUID) (svcinteractions.GradingDeps, error) {
	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return svcinteractions.GradingDeps{}, svc.ConnectDBError(err)
	}
	lang := lesson.Language

	return svcinteractions.GradingDeps{
		Language: lang,
		GradeAudio: func(ctx context.Context, audioBytes []byte, passageMarkdown, question string) (float32, float32, string, error) {
			result, err := s.GradeAudio(ctx, audioBytes, lang, passageMarkdown, question)
			if err != nil {
				return 0, 1, "", fmt.Errorf("AI audio grade: %w", err)
			}
			// Compute final score:
			// - PRONUNCIATION mode (question empty): score = pronunciation only
			// - OPEN_ANSWER mode: score = average of pronunciation + content
			var score float32
			if question == "" {
				score = result.PronunciationScore
			} else {
				score = (result.PronunciationScore + result.ContentScore) / 2
			}
			return score, 1.0, result.Feedback, nil
		},
		GetAudioBytes: func(ctx context.Context, objectKey string) ([]byte, error) {
			return s.downloadAudio(ctx, objectKey)
		},
	}, nil
}

func (s *AISvc) downloadAudio(ctx context.Context, objectKey string) ([]byte, error) {
	dlCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	const maxAudioBytes = int64(20 * 1024 * 1024) // 20 MB
	obj, err := s.s3client.GetObject(dlCtx, s.s3cfg.Bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("download audio: %w", err)
	}
	defer obj.Close()

	data, err := io.ReadAll(io.LimitReader(obj, maxAudioBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read audio bytes: %w", err)
	}
	if int64(len(data)) > maxAudioBytes {
		return nil, fmt.Errorf("audio file exceeds 20 MB limit")
	}
	return data, nil
}
