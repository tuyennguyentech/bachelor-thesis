package ai

import (
	"encoding/json"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func analysisToProto(a gen.LessonAnalysis, questions []gen.LessonQuestion) *richterv1.LessonAnalysis {
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
	}

	transcript := ""
	if a.Transcript.Valid {
		transcript = a.Transcript.String
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

	return &richterv1.LessonAnalysis{
		LessonId:  a.LessonID.String(),
		Status:    status,
		Transcript: transcript,
		ErrorMsg:  errMsg,
		Questions: protoQs,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}
}

func questionToProto(q gen.LessonQuestion) *richterv1.LessonQuestion {
	var opts []string
	_ = json.Unmarshal(q.Options, &opts)

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

	return &richterv1.LessonQuestion{
		Id:            q.ID.String(),
		LessonId:      q.LessonID.String(),
		QuestionText:  q.QuestionText,
		Options:       protoOpts,
		CorrectAnswer: q.CorrectAnswer,
		Explanation:   explanation,
		OrderIndex:    q.OrderIndex,
		CreatedAt:     createdAt,
	}
}
