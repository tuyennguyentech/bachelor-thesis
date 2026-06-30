package transcript

import (
	"context"
	"encoding/json"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// List returns the chunks of a lesson, ordered by OrderIndex. The caller
// must be a member of the lesson's organization.
func (s *Service) List(
	ctx context.Context,
	req *richterv1.ListLessonTranscriptChunksRequest,
) (*richterv1.ListLessonTranscriptChunksResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	orgID, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.RequireOrgMember.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	chunks, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		limit := req.GetLimit()
		if limit == 0 {
			limit = 500
		}
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: limit, Offset: req.GetOffset()})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	protoChunks := make([]*richterv1.TranscriptChunk, 0, len(chunks))
	for _, c := range chunks {
		protoChunks = append(protoChunks, chunkToProto(c))
	}
	return &richterv1.ListLessonTranscriptChunksResponse{Chunks: protoChunks}, nil
}

// UpdateConfig changes the per-chunk question-count target. Caller must
// be a teacher of the chunk's lesson.
func (s *Service) UpdateConfig(
	ctx context.Context,
	req *richterv1.UpdateChunkConfigRequest,
) (*richterv1.UpdateChunkConfigResponse, error) {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return nil, err
	}

	chunk, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.RequireTeacherRole(ctx, chunk.LessonID); err != nil {
		return nil, err
	}

	updated, err := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.UpdateChunkQuestionCountConfig(ctx, gen.UpdateChunkQuestionCountConfigParams{
			ID:                  chunkID,
			QuestionCountConfig: req.GetQuestionCount(),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateChunkConfigResponse{Chunk: chunkToProto(updated)}, nil
}

// chunkToProto converts a sqlc-generated LessonTranscriptChunk to the
// protobuf wire type. Kept here to avoid the ai package having to expose
// the mapper. If the mapper grows, promote it back to ai/mapper.go.
func chunkToProto(c gen.LessonTranscriptChunk) *richterv1.TranscriptChunk {
	return &richterv1.TranscriptChunk{
		Id:                  c.ID.String(),
		LessonId:            c.LessonID.String(),
		OrderIndex:          c.OrderIndex,
		StartSeconds:        float32(c.StartSeconds),
		EndSeconds:          float32(c.EndSeconds),
		Summary:             c.Summary,
		QuestionCountConfig: c.QuestionCountConfig,
		InteractionConfig:   parseInteractionConfig(c.InteractionConfig),
	}
}

// parseInteractionConfig decodes the JSON `interaction_config` blob into
// the protobuf type. Duplicated from ai/mapper.go because the transcript
// sub-package can't import the ai package (circular). Keep them in sync.
func parseInteractionConfig(data []byte) *richterv1.ChunkInteractionConfig {
	if len(data) == 0 {
		return nil
	}
	var raw struct {
		Count    int32    `json:"count"`
		Kinds    []string `json:"kinds"`
		Strategy string   `json:"strategy"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	if raw.Count == 0 && len(raw.Kinds) == 0 && raw.Strategy == "" {
		return nil
	}
	kinds := make([]richterv1.InteractionKind, 0, len(raw.Kinds))
	for _, ks := range raw.Kinds {
		// Best-effort: use the interactions package's DBStringToKind
		// via a callback-free path. If you add a new kind, update both
		// this switch and ai/mapper.go.
		var k richterv1.InteractionKind
		switch ks {
		case "single_choice":
			k = richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE
		case "fill_blank":
			k = richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK
		case "listening":
			k = richterv1.InteractionKind_INTERACTION_KIND_LISTENING
		case "reading":
			k = richterv1.InteractionKind_INTERACTION_KIND_READING
		}
		if k != richterv1.InteractionKind_INTERACTION_KIND_UNSPECIFIED {
			kinds = append(kinds, k)
		}
	}
	strategy := richterv1.GenerationStrategy_GENERATION_STRATEGY_UNSPECIFIED
	switch raw.Strategy {
	case "ai_choose":
		strategy = richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE
	case "even":
		strategy = richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION
	}
	return &richterv1.ChunkInteractionConfig{
		Count:    raw.Count,
		Kinds:    kinds,
		Strategy: strategy,
	}
}
