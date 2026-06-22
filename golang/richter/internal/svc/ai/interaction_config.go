package ai

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	svcinteractions "example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *AISvc) UpdateChunkInteractionConfig(
	ctx context.Context,
	req *richterv1.UpdateChunkInteractionConfigRequest,
) (*richterv1.UpdateChunkInteractionConfigResponse, error) {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return nil, err
	}
	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, chunk.LessonID); err != nil {
		return nil, err
	}

	updated, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.UpdateChunkInteractionConfig(ctx, gen.UpdateChunkInteractionConfigParams{
			ID:                chunkID,
			InteractionConfig: interactionConfigToJSON(req.GetInteractionConfig()),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateChunkInteractionConfigResponse{Chunk: chunkToProto(updated)}, nil
}

func (s *AISvc) UpdateLessonDefaultInteractionConfig(
	ctx context.Context,
	req *richterv1.UpdateLessonDefaultInteractionConfigRequest,
) (*richterv1.UpdateLessonDefaultInteractionConfigResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}
	if _, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.UpdateLessonDefaultInteractionConfig(ctx, gen.UpdateLessonDefaultInteractionConfigParams{
			ID:                       lessonID,
			DefaultInteractionConfig: interactionConfigToJSON(req.GetDefaultInteractionConfig()),
		})
	}); err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateLessonDefaultInteractionConfigResponse{}, nil
}

// doRegenerateInteraction is provided to InteractionsSvc as AIRegenerateFunc via DI.
// It loads the existing interaction, calls Gemini for one item, and replaces the DB row.
func (s *AISvc) doRegenerateInteraction(
	ctx context.Context,
	interactionID pgtype.UUID,
	newKind richterv1.InteractionKind,
	customPrompt string,
) (*gen.LessonInteraction, error) {
	existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.GetLessonInteractionByID(ctx, interactionID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if !existing.ChunkID.Valid {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("interaction has no chunk — cannot AI-regenerate"))
	}

	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, existing.ChunkID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	handler := svcinteractions.Get(newKind)
	if handler == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no handler for kind %v", newKind))
	}
	geminiGen, ok := handler.(svcinteractions.GeminiGenerator)
	if !ok {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("kind %v does not support AI generation", newKind))
	}

	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, existing.LessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	chunkTranscript := s.fetchChunkTranscript(chunk.ID.String())
	if strings.TrimSpace(chunkTranscript) == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("chunk has no transcript content"))
	}

	chunkForRegen := chunk
	chunkForRegen.QuestionCountConfig = 1
	kindStr := svcinteractions.KindToDBString(newKind)
	items, err := s.generation.GenerateItems(ctx, chunkForRegen, chunkTranscript, geminiGen, kindStr, lesson.Language, "", customPrompt)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("AI generation failed: %w", err))
	}
	if len(items) == 0 {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("AI did not produce any output"))
	}

	updated, err := s.generation.ReplaceInteractionWithGeneratedItem(ctx, interactionID, items[0])
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &updated, nil
}

// synthesizeListeningAudio is provided to InteractionsSvc as ListeningAudioSynthesizer
// via DI. It synthesises the listening question `text` to speech in the lesson's
// output language and embeds the uploaded audio_object_key into configJSON — so a
// manual create/edit of a listening question regenerates its audio from the text.
func (s *AISvc) synthesizeListeningAudio(
	ctx context.Context,
	lessonID pgtype.UUID,
	configJSON []byte,
	text string,
) ([]byte, error) {
	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	prov, ok := svcinteractions.Get(richterv1.InteractionKind_INTERACTION_KIND_LISTENING).(svcinteractions.TTSProvider)
	if !ok {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listening handler is not a TTSProvider"))
	}
	return s.synthesiseAndEmbed(ctx, prov, configJSON, text, lesson.Language, lessonID.String())
}
