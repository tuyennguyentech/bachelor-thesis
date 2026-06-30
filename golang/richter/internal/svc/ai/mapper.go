package ai

import (
	"encoding/json"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/interactions"
	"example.com/sql/gen"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// interactionConfigJSON is the on-disk shape for interaction_config / default_interaction_config.
type interactionConfigJSON struct {
	Count    int32    `json:"count,omitempty"`
	Kinds    []string `json:"kinds,omitempty"`
	Strategy string   `json:"strategy,omitempty"`
}

// interactionConfigToJSON serializes a ChunkInteractionConfig proto to JSON for DB storage.
// Returns nil when cfg is nil or effectively empty.
func interactionConfigToJSON(cfg *richterv1.ChunkInteractionConfig) []byte {
	if cfg == nil {
		return nil
	}
	kinds := make([]string, 0, len(cfg.GetKinds()))
	for _, k := range cfg.GetKinds() {
		kinds = append(kinds, interactions.KindToDBString(k))
	}
	strategy := ""
	switch cfg.GetStrategy() {
	case richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE:
		strategy = "ai_choose"
	case richterv1.GenerationStrategy_GENERATION_STRATEGY_EVEN_DISTRIBUTION:
		strategy = "even"
	}
	raw := interactionConfigJSON{Count: cfg.GetCount(), Kinds: kinds, Strategy: strategy}
	if raw.Count == 0 && len(raw.Kinds) == 0 && raw.Strategy == "" {
		return nil
	}
	data, _ := json.Marshal(raw)
	return data
}

// interactionConfigFromJSON deserializes DB JSON into a ChunkInteractionConfig proto.
// Returns nil when data is empty or contains only zero values.
func interactionConfigFromJSON(data []byte) *richterv1.ChunkInteractionConfig {
	if len(data) == 0 {
		return nil
	}
	var raw interactionConfigJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	if raw.Count == 0 && len(raw.Kinds) == 0 && raw.Strategy == "" {
		return nil
	}
	kinds := make([]richterv1.InteractionKind, 0, len(raw.Kinds))
	for _, ks := range raw.Kinds {
		k := interactions.DBStringToKind(ks)
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

func analysisToProto(a gen.LessonAnalysis, ints []gen.LessonInteraction, stripAnswers bool, transcript string, segments []transcriptSegment, defaultCfg *richterv1.ChunkInteractionConfig) *richterv1.LessonAnalysis {
	status := richterv1.AnalysisStatus_ANALYSIS_STATUS_UNSPECIFIED
	switch a.Status {
	case gen.LessonAnalysisStatusPending:
		status = richterv1.AnalysisStatus_ANALYSIS_STATUS_PENDING
	case gen.LessonAnalysisStatusProcessing:
		status = richterv1.AnalysisStatus_ANALYSIS_STATUS_PROCESSING
	case gen.LessonAnalysisStatusDone:
		status = richterv1.AnalysisStatus_ANALYSIS_STATUS_DONE
	case gen.LessonAnalysisStatusError:
		status = richterv1.AnalysisStatus_ANALYSIS_STATUS_ERROR
	case gen.LessonAnalysisStatusTranscriptExtracted:
		status = richterv1.AnalysisStatus_ANALYSIS_STATUS_TRANSCRIPT_EXTRACTED
	case gen.LessonAnalysisStatusChunksReady:
		status = richterv1.AnalysisStatus_ANALYSIS_STATUS_CHUNKS_READY
	}

	errMsg := ""
	if a.ErrorMsg.Valid {
		errMsg = a.ErrorMsg.String
	}

	protoInts := make([]*richterv1.LessonInteraction, 0, len(ints))
	for _, i := range ints {
		protoInts = append(protoInts, interactions.InteractionToProto(i, stripAnswers))
	}

	var createdAt, updatedAt *timestamppb.Timestamp
	if a.CreatedAt.Valid {
		createdAt = svc.TimestampToProto(a.CreatedAt)
	}
	if a.UpdatedAt.Valid {
		updatedAt = svc.TimestampToProto(a.UpdatedAt)
	}

	protoSegs := make([]*richterv1.TranscriptSegment, 0, len(segments))
	for _, seg := range segments {
		protoSegs = append(protoSegs, &richterv1.TranscriptSegment{
			StartSeconds: seg.StartSeconds,
			EndSeconds:   seg.EndSeconds,
			Text:         seg.Text,
		})
	}

	return &richterv1.LessonAnalysis{
		LessonId:                 a.LessonID.String(),
		Status:                   status,
		ErrorMsg:                 errMsg,
		Transcript:               transcript,
		Interactions:             protoInts,
		CreatedAt:                createdAt,
		UpdatedAt:                updatedAt,
		TranscriptSegments:       protoSegs,
		DefaultInteractionConfig: defaultCfg,
	}
}

func chunkToProto(c gen.LessonTranscriptChunk) *richterv1.TranscriptChunk {
	return &richterv1.TranscriptChunk{
		Id:                  c.ID.String(),
		LessonId:            c.LessonID.String(),
		OrderIndex:          c.OrderIndex,
		StartSeconds:        float32(c.StartSeconds),
		EndSeconds:          float32(c.EndSeconds),
		Summary:             c.Summary,
		QuestionCountConfig: c.QuestionCountConfig,
		InteractionConfig:   interactionConfigFromJSON(c.InteractionConfig),
	}
}
