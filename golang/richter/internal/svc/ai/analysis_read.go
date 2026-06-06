package ai

import (
	"context"
	"errors"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *AISvc) GetLessonAnalysis(
	ctx context.Context,
	req *richterv1.GetLessonAnalysisRequest,
) (*richterv1.GetLessonAnalysisResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	analysis, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
		return q.GetLessonAnalysis(ctx, lessonID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &richterv1.GetLessonAnalysisResponse{}, nil
		}
		return nil, svc.ConnectDBError(err)
	}

	ints, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
			LessonID: lessonID,
			Limit:    500,
			Offset:   0,
		})
	})
	if err != nil {
		s.log.ErrorContext(ctx, "ai: failed to list lesson interactions", svc.LogAttrs("ListLessonInteractions", err)...)
	}

	chunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 500, Offset: 0})
	})
	if err != nil {
		s.log.ErrorContext(ctx, "ai: failed to list lesson chunks", svc.LogAttrs("ListLessonTranscriptChunks", err)...)
	}
	normalizeGeneratedInteractionStartSeconds(ints, chunks)

	lessonIDStr := lessonID.String()
	// Don't return stale FDB data when video has been replaced (status reset to pending).
	var transcript string
	var segments []transcriptSegment
	if analysis.Status != gen.LessonAnalysisStatusPending {
		transcript = s.loadTranscriptFromFDB(lessonIDStr)
		segments = s.loadSegmentsFromFDB(lessonIDStr)
	}

	protoChunks := make([]*richterv1.TranscriptChunk, 0, len(chunks))
	for _, c := range chunks {
		protoChunks = append(protoChunks, chunkToProto(c))
	}

	// Determine answer visibility: teachers always see answers; students only after submission.
	isTeacher := false
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	); err == nil {
		isTeacher = true
	}

	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	hasSubmitted := false
	if !isTeacher {
		if claims, _ := s.authz.RequireAuthenticated(ctx); claims != nil {
			if userID, perr := svc.ParseUUID(claims.GetSub()); perr == nil {
				if _, aerr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
					return q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{LessonID: lessonID, UserID: userID})
				}); aerr == nil {
					hasSubmitted = true
				}
			}
		}
	}

	strip := svcinteractions.ShouldStripAnswers(lesson.FeedbackMode, isTeacher, hasSubmitted)
	return &richterv1.GetLessonAnalysisResponse{
		Analysis: analysisToProto(analysis, ints, strip, transcript, segments, interactionConfigFromJSON(lesson.DefaultInteractionConfig)),
		Chunks:   protoChunks,
	}, nil
}
