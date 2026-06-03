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
		GradeAudio: func(ctx context.Context, audioBytes []byte, passageMarkdown, question, expectedAnswer string) (float32, float32, string, error) {
			result, err := s.GradeAudio(ctx, audioBytes, lang, passageMarkdown, question, expectedAnswer)
			if err != nil {
				// Don't fail the whole submit on AI grading error (Gemini rejection of
				// audio format, transient API failure, etc.). Give pending credit and
				// leave a fallback message so the teacher can manually review.
				s.log.WarnContext(ctx, "AI audio grading failed, falling back to pending credit", "err", err)
				const fallback = "Hệ thống AI tạm thời chưa chấm được phần ghi âm này. Giáo viên sẽ xem lại."
				return 0.5, 1.0, fallback, nil
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
			feedback := result.Feedback
			if result.Transcript != "" {
				feedback = "Bạn đã nói: \"" + result.Transcript + "\"\n\n" + feedback
			}
			return score, 1.0, feedback, nil
		},
		GradeText: func(ctx context.Context, question, studentAnswer, expectedAnswer string) (float32, float32, string, error) {
			score, feedback, err := s.GradeText(ctx, lang, question, studentAnswer, expectedAnswer)
			if err != nil {
				s.log.WarnContext(ctx, "AI text grading failed, falling back to pending credit", "err", err)
				const fallback = "Hệ thống AI tạm thời chưa chấm được câu này. Giáo viên sẽ xem lại."
				return 0.5, 1.0, fallback, nil
			}
			return score, 1.0, feedback, nil
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
