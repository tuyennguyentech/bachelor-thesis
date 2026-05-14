package ai

import (
	"encoding/json"
	"log/slog"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func analysisToProto(a gen.LessonAnalysis, questions []gen.LessonQuestion, transcript string, segments []transcriptSegment) *richterv1.LessonAnalysis {
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

	var protoQs []*richterv1.LessonQuestion
	for _, q := range questions {
		protoQs = append(protoQs, questionToProto(q))
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
		LessonId:           a.LessonID.String(),
		Status:             status,
		ErrorMsg:           errMsg,
		Transcript:         transcript,
		Questions:          protoQs,
		CreatedAt:          createdAt,
		UpdatedAt:          updatedAt,
		TranscriptSegments: protoSegs,
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
	}
}

func questionToProto(q gen.LessonQuestion) *richterv1.LessonQuestion {
	var opts []string
	if err := json.Unmarshal(q.Options, &opts); err != nil {
		slog.Warn("questionToProto: corrupted options JSON in DB", "question_id", q.ID.String(), "err", err)
	}

	protoOpts := make([]*richterv1.MCQOption, 0, len(opts))
	for _, o := range opts {
		protoOpts = append(protoOpts, &richterv1.MCQOption{Text: o})
	}

	explanation := ""
	if q.Explanation.Valid {
		explanation = q.Explanation.String
	}

	var createdAt *timestamppb.Timestamp
	if q.CreatedAt.Valid {
		createdAt = svc.TimestampToProto(q.CreatedAt)
	}

	chunkID := ""
	if q.ChunkID.Valid {
		chunkID = q.ChunkID.String()
	}

	return &richterv1.LessonQuestion{
		Id:            q.ID.String(),
		LessonId:      q.LessonID.String(),
		QuestionText:  q.QuestionText,
		Options:       protoOpts,
		CorrectAnswer: q.CorrectAnswer,
		Explanation:   explanation,
		OrderIndex:    q.OrderIndex,
		CreatedAt:     createdAt,
		StartSeconds:  float32(q.StartSeconds),
		ChunkId:       chunkID,
	}
}
