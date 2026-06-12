package interactions

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

// Learning-analytics thresholds.
const (
	// heatmapGapThreshold: a chunk with response_count > 0 and avg_score below
	// this fraction is flagged as a comprehension "gap".
	heatmapGapThreshold = 0.6
	// engagementWarnThreshold: an attempt with engagement score below this is
	// considered low-engagement when scanning for at-risk students.
	engagementWarnThreshold = 40.0
	// atRiskMinStreak: minimum consecutive low-engagement lessons to flag a student.
	atRiskMinStreak = 2
)

// ── LessonHeatmap ─────────────────────────────────────────────────────────────

// LessonHeatmap returns a per-chunk score heatmap for a lesson, flagging chunks
// where students answered but scored poorly as comprehension gaps.
func (s *InteractionsSvc) LessonHeatmap(
	ctx context.Context,
	req *richterv1.LessonHeatmapRequest,
) (*richterv1.LessonHeatmapResponse, error) {
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
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner, gen.OrganizationRoleAdmin, gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	rows, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonChunkScoreHeatmapRow, error) {
		return q.LessonChunkScoreHeatmap(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	cells := make([]*richterv1.ChunkScoreCell, 0, len(rows))
	for _, r := range rows {
		cells = append(cells, &richterv1.ChunkScoreCell{
			ChunkId:       r.ChunkID.String(),
			ChunkIndex:    r.ChunkIndex,
			StartSeconds:  float32(r.StartSeconds),
			EndSeconds:    float32(r.EndSeconds),
			Summary:       r.Summary,
			AvgScore:      r.AvgScore,
			ResponseCount: r.ResponseCount,
			StudentCount:  r.StudentCount,
			IsGap:         r.ResponseCount > 0 && r.AvgScore < heatmapGapThreshold,
		})
	}

	return &richterv1.LessonHeatmapResponse{
		Cells:        cells,
		GapThreshold: heatmapGapThreshold,
	}, nil
}

// ── ListAtRiskStudents ────────────────────────────────────────────────────────

// ListAtRiskStudents lists students with a run of >= atRiskMinStreak consecutive
// low-engagement lessons (in course order). Pagination is applied in Go because
// the at-risk determination requires scanning every attempt per student.
func (s *InteractionsSvc) ListAtRiskStudents(
	ctx context.Context,
	req *richterv1.ListAtRiskStudentsRequest,
) (*richterv1.ListAtRiskStudentsResponse, error) {
	courseID, err := svc.ParseUUID(req.GetCourseId())
	if err != nil {
		return nil, err
	}

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		course, err := q.GetCourseByID(ctx, courseID)
		if err != nil {
			return pgtype.UUID{}, err
		}
		return course.OrganizationID, nil
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner, gen.OrganizationRoleAdmin, gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	rows, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListCourseAttemptEngagementInputsRow, error) {
		return q.ListCourseAttemptEngagementInputs(ctx, courseID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	atRisk := buildAtRiskStudents(rows)

	total := int32(len(atRisk))

	limit := req.GetLimit()
	if limit == 0 {
		limit = 50
	}
	offset := req.GetOffset()
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}

	return &richterv1.ListAtRiskStudentsResponse{
		Students: atRisk[offset:end],
		Total:    total,
	}, nil
}

// buildAtRiskStudents walks the pre-sorted (user_id, module_order, lesson_order)
// engagement rows and emits one AtRiskStudent per student whose longest run of
// consecutive low-engagement lessons is >= atRiskMinStreak. low_streak carries
// that maximal run.
func buildAtRiskStudents(rows []gen.ListCourseAttemptEngagementInputsRow) []*richterv1.AtRiskStudent {
	var out []*richterv1.AtRiskStudent

	i := 0
	for i < len(rows) {
		j := i
		// Collect the contiguous block of rows for this user (rows are pre-sorted by user_id).
		for j < len(rows) && rows[j].UserID == rows[i].UserID {
			j++
		}
		block := rows[i:j]
		i = j

		var (
			curRun  []*richterv1.AtRiskLessonPoint
			bestRun []*richterv1.AtRiskLessonPoint
		)
		flush := func() {
			if len(curRun) > len(bestRun) {
				bestRun = curRun
			}
			curRun = nil
		}
		for _, r := range block {
			eng := computeEngagementScore(r.WatchFraction, r.ResponseRate, r.ScoreFraction)
			if eng < engagementWarnThreshold {
				curRun = append(curRun, &richterv1.AtRiskLessonPoint{
					LessonId:        r.LessonID.String(),
					LessonTitle:     r.LessonTitle,
					EngagementScore: eng,
				})
			} else {
				flush()
			}
		}
		flush()

		if len(bestRun) >= atRiskMinStreak {
			head := block[0]
			out = append(out, &richterv1.AtRiskStudent{
				UserId:      head.UserID.String(),
				DisplayName: buildDisplayName(head.FirstName, head.MiddleName, head.LastName),
				Email:       head.Email,
				LowStreak:   bestRun,
			})
		}
	}

	return out
}

// ── GetLessonQuestionAnalytics ────────────────────────────────────────────────

// GetLessonQuestionAnalytics returns per-question accuracy by kind, MCQ option
// distributions (misconception analysis), and average free-text response length.
func (s *InteractionsSvc) GetLessonQuestionAnalytics(
	ctx context.Context,
	req *richterv1.GetLessonQuestionAnalyticsRequest,
) (*richterv1.GetLessonQuestionAnalyticsResponse, error) {
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
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner, gen.OrganizationRoleAdmin, gen.OrganizationRoleTeacher,
	); err != nil {
		return nil, err
	}

	type qaResult struct {
		kindRows []gen.LessonAccuracyByKindRow
		mcqRows  []gen.LessonMcqOptionDistributionRow
		// configs: single-choice interaction config + prompt keyed by interaction id.
		interactions map[string]gen.LessonInteraction
		// avgWords inputs gathered across all responses in the lesson.
		wordTotal int
		wordCount int
	}

	res, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (qaResult, error) {
		var r qaResult
		var err error
		if r.kindRows, err = q.LessonAccuracyByKind(ctx, lessonID); err != nil {
			return r, err
		}
		if r.mcqRows, err = q.LessonMcqOptionDistribution(ctx, lessonID); err != nil {
			return r, err
		}

		// Load every interaction in the lesson once: used to resolve MCQ option
		// text + correct answer, and (implicitly) bounds the response scan.
		r.interactions = map[string]gen.LessonInteraction{}
		const pageSize = int32(500)
		var offset int32
		for {
			page, err := q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
				LessonID: lessonID, Limit: pageSize, Offset: offset,
			})
			if err != nil {
				return r, err
			}
			for _, it := range page {
				r.interactions[it.ID.String()] = it
			}
			if int32(len(page)) < pageSize {
				break
			}
			offset += pageSize
		}

		// avg_response_length_words: scan every attempt's responses, measuring
		// free-text length via TextResponseMeasurer (fill_blank + listening only).
		r.wordTotal, r.wordCount, err = measureLessonResponseWords(ctx, q, lessonID)
		if err != nil {
			return r, err
		}
		return r, nil
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	// (a) kind accuracy
	kindAccuracy := make([]*richterv1.KindAccuracy, 0, len(res.kindRows))
	for _, kr := range res.kindRows {
		kindAccuracy = append(kindAccuracy, &richterv1.KindAccuracy{
			Kind:          kr.Kind,
			ResponseCount: kr.ResponseCount,
			Accuracy:      kr.Accuracy,
		})
	}

	// (b) mcq misconception stats — group distribution rows by interaction.
	mcqStats := buildMcqStats(res.mcqRows, res.interactions)

	// (c) average free-text response length in words.
	avgWords := float64(0)
	if res.wordCount > 0 {
		avgWords = float64(res.wordTotal) / float64(res.wordCount)
	}

	return &richterv1.GetLessonQuestionAnalyticsResponse{
		KindAccuracy:           kindAccuracy,
		McqStats:               mcqStats,
		AvgResponseLengthWords: avgWords,
	}, nil
}

// buildMcqStats groups option-distribution rows by interaction and decorates them
// with option text + correctness parsed from each single-choice interaction config.
func buildMcqStats(
	rows []gen.LessonMcqOptionDistributionRow,
	interactions map[string]gen.LessonInteraction,
) []*richterv1.McqInteractionStats {
	// Preserve interaction order of first appearance (rows are sorted by interaction_id).
	var order []string
	grouped := map[string][]gen.LessonMcqOptionDistributionRow{}
	for _, r := range rows {
		id := r.InteractionID.String()
		if _, seen := grouped[id]; !seen {
			order = append(order, id)
		}
		grouped[id] = append(grouped[id], r)
	}

	out := make([]*richterv1.McqInteractionStats, 0, len(order))
	for _, id := range order {
		it, ok := interactions[id]
		cfg := singleChoiceConfig{CorrectAnswer: -1}
		prompt := ""
		if ok {
			prompt = it.Prompt
			_ = json.Unmarshal(it.Config, &cfg)
		}

		opts := make([]*richterv1.McqOptionStat, 0, len(grouped[id]))
		for _, r := range grouped[id] {
			text := ""
			if int(r.OptionIndex) >= 0 && int(r.OptionIndex) < len(cfg.Options) {
				text = cfg.Options[r.OptionIndex]
			}
			opts = append(opts, &richterv1.McqOptionStat{
				OptionIndex: r.OptionIndex,
				OptionText:  text,
				ChosenCount: r.ChosenCount,
				IsCorrect:   int(r.OptionIndex) == cfg.CorrectAnswer,
			})
		}
		out = append(out, &richterv1.McqInteractionStats{
			InteractionId: id,
			Prompt:        prompt,
			Options:       opts,
		})
	}
	return out
}

// measureLessonResponseWords scans every attempt in the lesson and sums the word
// counts of free-text responses (those whose handler implements
// TextResponseMeasurer). Returns (totalWords, contributingResponses).
func measureLessonResponseWords(ctx context.Context, q *gen.Queries, lessonID pgtype.UUID) (int, int, error) {
	const pageSize = int32(200)
	var (
		offset    int32
		wordTotal int
		wordCount int
	)
	for {
		attempts, err := q.ListLessonAttempts(ctx, gen.ListLessonAttemptsParams{
			LessonID: lessonID, Limit: pageSize, Offset: offset,
		})
		if err != nil {
			return 0, 0, err
		}
		for _, a := range attempts {
			resps, err := q.ListAttemptResponses(ctx, a.ID)
			if err != nil {
				return 0, 0, err
			}
			for _, resp := range resps {
				h := Get(dbStringToKind(resp.InteractionKind))
				measurer, ok := h.(TextResponseMeasurer)
				if !ok {
					continue
				}
				n, contributes := measurer.ResponseWordCount(resp.Response)
				if !contributes {
					continue
				}
				wordTotal += n
				wordCount++
			}
		}
		if int32(len(attempts)) < pageSize {
			break
		}
		offset += pageSize
	}
	return wordTotal, wordCount, nil
}
