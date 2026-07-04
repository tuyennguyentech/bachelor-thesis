package ai

import (
	"context"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
)

// resetChunkListLimit bounds the chunk-id snapshot we take for FDB cleanup. No
// real lesson approaches this many chunks; it just prevents an unbounded scan.
const resetChunkListLimit = 1000

// ResetLessonContent wipes ALL derived content for a lesson — the video object
// and its pointer, the transcript + segments (FDB), the chunks, the generated
// interactions, the student attempts, and the analysis row — returning the
// lesson to its blank "before Tạo nhanh" state. Manager-only and idempotent
// (re-running on an already-blank lesson is a no-op).
func (s *AISvc) ResetLessonContent(
	ctx context.Context,
	req *richterv1.ResetLessonContentRequest,
) (*richterv1.ResetLessonContentResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}
	lessonIDStr := lessonID.String()

	// Snapshot the video key + chunk ids for storage/FDB cleanup before deleting.
	var videoKey string
	var chunkIDs []string
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		lesson, err := q.GetLessonByID(ctx, lessonID)
		if err != nil {
			return err
		}
		if lesson.VideoStorageKey.Valid {
			videoKey = lesson.VideoStorageKey.String
		}
		chunks, err := q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
			LessonID: lessonID, Limit: resetChunkListLimit, Offset: 0,
		})
		if err != nil {
			return err
		}
		for _, c := range chunks {
			chunkIDs = append(chunkIDs, c.ID.String())
		}
		return nil
	}); err != nil {
		return nil, svc.ConnectDBError(err)
	}

	// Delete the video object from storage. Best-effort: a missing object (e.g.
	// already reset) must not block the rest of the wipe.
	if videoKey != "" {
		if rerr := s.s3client.RemoveObject(ctx, s.s3cfg.Bucket, videoKey, minio.RemoveObjectOptions{}); rerr != nil {
			s.log.WarnContext(ctx, "reset: remove video object failed", "err", rerr, "key", videoKey)
		}
	}

	// Delete generated + preview listening audio (accumulated from AI generation,
	// manual edits, and "Nghe thử" previews). Best-effort, prefix sweep.
	for _, prefix := range []string{
		"lessons/" + lessonID.String() + "/ai-audio/",
		"lessons/" + lessonID.String() + "/ai-audio-preview/",
	} {
		for obj := range s.s3client.ListObjects(ctx, s.s3cfg.Bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if obj.Err != nil {
				continue
			}
			if rerr := s.s3client.RemoveObject(ctx, s.s3cfg.Bucket, obj.Key, minio.RemoveObjectOptions{}); rerr != nil {
				s.log.WarnContext(ctx, "reset: remove ai-audio object failed", "err", rerr, "key", obj.Key)
			}
		}
	}

	// Wipe all DB-side content + clear the lesson's video pointer in one go.
	// Order: interactions (cascades attempt_responses) → chunks → attempts →
	// analysis row → clear video pointer.
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		if err := q.DeleteLessonInteractionsByLesson(ctx, lessonID); err != nil {
			return err
		}
		if err := q.DeleteLessonTranscriptChunks(ctx, lessonID); err != nil {
			return err
		}
		if err := q.DeleteLessonAttempts(ctx, lessonID); err != nil {
			return err
		}
		if err := q.DeleteLessonAnalysis(ctx, lessonID); err != nil {
			return err
		}
		// Delete task history too. GetLessonAnalysis derives the analysis status
		// from the LATEST task per kind (analysis_read.go), so a leftover SUCCEEDED
		// transcribe/chunk/pipeline task makes a fully-wiped lesson keep reporting
		// TRANSCRIPT_EXTRACTED/CHUNKS_READY/DONE — the stepper then shows "Đã có
		// transcript" and lets chunking run even though no video/transcript exists.
		// The video-replace path already does this (lessons/lesson_video.go).
		if err := q.DeleteTasksForLesson(ctx, lessonID); err != nil {
			return err
		}
		_, err := q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
			ID:              lessonID,
			VideoStorageKey: pgtype.Text{},
			DurationSeconds: pgtype.Int4{},
		})
		return err
	}); err != nil {
		return nil, svc.ConnectDBError(err)
	}

	// FDB cleanup: lesson transcript/segments + per-chunk transcripts.
	segment.DeleteLessonTranscripts(s.kv, lessonIDStr)
	for _, id := range chunkIDs {
		_ = segment.DeleteChunkTranscript(s.kv, id)
	}

	return &richterv1.ResetLessonContentResponse{}, nil
}
