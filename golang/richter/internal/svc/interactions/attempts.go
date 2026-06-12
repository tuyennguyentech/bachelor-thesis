package interactions

import (
	"bytes"
	"context"
	"fmt"
	"sync"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"
)

func (s *InteractionsSvc) SubmitAttempt(
	ctx context.Context,
	req *richterv1.SubmitAttemptRequest,
) (*richterv1.SubmitAttemptResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(claims.Sub)
	if err != nil {
		return nil, err
	}

	// Course-level access: only users enrolled in the course (or org
	// owner/admin, course owner, sys-admin) may submit attempts.
	if _, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID); err != nil {
		return nil, err
	}

	// Load the lesson to check max_attempts
	lesson, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	if lesson.MaxAttempts > 0 {
		prevAttempt, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
			return q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{LessonID: lessonID, UserID: userID})
		})
		if err == nil {
			if prevAttempt.AttemptCount >= lesson.MaxAttempts {
				return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("bạn đã hết số lần làm bài cho phép (tối đa %d lần)", lesson.MaxAttempts))
			}
		}
	}

	// Load all interactions for this lesson to grade responses
	interactions, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
			LessonID: lessonID, Limit: s.listLimit(), Offset: 0,
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if len(interactions) == 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("lesson has no interactions"))
	}

	// Index interactions by ID for fast lookup
	interactionByID := make(map[string]gen.LessonInteraction, len(interactions))
	for _, i := range interactions {
		interactionByID[i.ID.String()] = i
	}

	type gradedResponse struct {
		interactionID pgtype.UUID
		responseJSON  []byte
		score         float32
		maxScore      float32
		feedback      string
	}

	graded := make([]gradedResponse, len(req.GetResponses()))
	var wg sync.WaitGroup
	var resolveOnce sync.Once
	var deps GradingDeps
	var resolveErr error

	getDeps := func(gradeCtx context.Context) (GradingDeps, error) {
		resolveOnce.Do(func() {
			if s.gradingDeps != nil {
				deps, resolveErr = s.gradingDeps(gradeCtx, lessonID)
			}
		})
		return deps, resolveErr
	}

	for idx, respInput := range req.GetResponses() {
		interaction, ok := interactionByID[respInput.GetInteractionId()]
		if !ok {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("interaction %s not found", respInput.GetInteractionId()))
		}

		kind := dbStringToKind(interaction.Kind)
		h := Get(kind)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no handler for interaction kind %q", interaction.Kind))
		}

		responseJSON, err := h.ResponseProtoToJSON(respInput)
		if err != nil {
			return nil, err
		}

		iid, err := svc.ParseUUID(respInput.GetInteractionId())
		if err != nil {
			return nil, err
		}

		graded[idx] = gradedResponse{
			interactionID: iid,
			responseJSON:  responseJSON,
		}

		var useCache bool
		if s.kv != nil {
			cachedBytes, cerr := s.kv.Get("temp_grade", tuple.Tuple{claims.Sub, lessonID.String(), respInput.GetInteractionId()})
			if cerr == nil && cachedBytes != nil {
				cached := &richterv1.FdbTempGradeCache{}
				if proto.Unmarshal(cachedBytes, cached) == nil {
					if bytes.Equal(cached.GetResponsePayload(), responseJSON) {
						graded[idx].score = cached.GetScore()
						graded[idx].maxScore = cached.GetMaxScore()
						graded[idx].feedback = cached.GetFeedback()
						useCache = true
					}
				}
			}
		}

		if useCache {
			continue
		}

		wg.Add(1)
		go func(i int, resp *richterv1.AttemptResponseInput, inter gen.LessonInteraction, handler Handler) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					s.log.ErrorContext(ctx, "interactions: panic in per-interaction grade",
						"interaction_id", resp.GetInteractionId(), "recover", r)
					graded[i].score = 0
					graded[i].maxScore = 1
					graded[i].feedback = "Hệ thống gặp lỗi khi chấm câu này. Giáo viên sẽ xem lại."
				}
			}()

			gradeCtx, cancel := s.aiCtx(ctx, s.intCfg.GradingTimeout)
			defer cancel()

			var score, maxScore float32
			var feedback string
			var gerr error

			if cg, ok := handler.(ContextualGrader); ok && s.gradingDeps != nil {
				d, derr := getDeps(gradeCtx)
				if derr != nil {
					s.log.ErrorContext(ctx, "interactions: resolve grading deps failed",
						"interaction_id", resp.GetInteractionId(), "err", derr)
					score, maxScore, feedback = 0, 1, "Hệ thống chưa thể chấm câu này. Giáo viên sẽ xem lại."
				} else {
					score, maxScore, feedback, gerr = cg.GradeWithContext(gradeCtx, d, inter.Config, graded[i].responseJSON)
				}
			} else {
				score, maxScore, feedback, gerr = handler.Grade(inter.Config, graded[i].responseJSON)
			}

			if gerr != nil {
				s.log.WarnContext(ctx, "interactions: grade returned error, falling back to pending credit",
					"interaction_id", resp.GetInteractionId(), "err", gerr)
				score, maxScore, feedback = 0, 1, "Hệ thống chưa chấm được câu này. Giáo viên sẽ xem lại."
			}

			graded[i].score = score
			graded[i].maxScore = maxScore
			graded[i].feedback = feedback
		}(idx, respInput, interaction, h)
	}

	wg.Wait()

	var totalScore, totalMaxScore float32
	for _, g := range graded {
		totalScore += g.score
		totalMaxScore += g.maxScore
	}

	// Load the previous attempt (if any) and its responses once. Reused for
	// two purposes: best-effort audio cleanup on retake, and deciding whether
	// this submission should consume an attempt (shouldIncrement).
	var (
		hasPrevAttempt   bool
		prevAttempt      gen.LessonAttempt
		prevResponseJSON = make(map[string][]byte) // interactionID string → stored response JSON
	)
	if pa, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
		return q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{LessonID: lessonID, UserID: userID})
	}); err == nil {
		hasPrevAttempt = true
		prevAttempt = pa
		if prevResponses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListAttemptResponsesRow, error) {
			return q.ListAttemptResponses(ctx, pa.ID)
		}); err == nil {
			for _, pr := range prevResponses {
				prevResponseJSON[pr.InteractionID.String()] = pr.Response
			}
		}
	}

	// Collect old audio keys to delete after upsert (best-effort cleanup on retake).
	var oldAudioKeys []string
	if s.deleteAudio != nil && hasPrevAttempt {
		for iid, respJSON := range prevResponseJSON {
			interactionRow, ok := interactionByID[iid]
			if !ok {
				continue
			}
			kind := dbStringToKind(interactionRow.Kind)
			h := Get(kind)
			if h == nil {
				continue
			}
			if ac, ok := h.(AudioObjectCleaner); ok {
				if key := ac.AudioObjectKeyFromResponse(respJSON); key != "" {
					oldAudioKeys = append(oldAudioKeys, key)
				}
			}
		}
	}

	// Decide whether this submission consumes an attempt. First submission
	// always increments. A resubmit increments only when something graded
	// actually changed — any per-interaction response JSON differs, or the
	// total score differs. No-op resubmits (e.g. re-opening and re-saving the
	// same answers) must not burn an attempt against max_attempts.
	shouldIncrement := true
	if hasPrevAttempt {
		changed := totalScore != prevAttempt.TotalScore
		if !changed {
			for _, g := range graded {
				prev, ok := prevResponseJSON[g.interactionID.String()]
				if !ok || !bytes.Equal(prev, g.responseJSON) {
					changed = true
					break
				}
			}
		}
		shouldIncrement = changed
	}

	// Build a per-interaction metrics map keyed by interaction ID string
	// so we can persist time_to_answer_ms and replay_count per response.
	type inputMetrics struct {
		timeToAnswerMs int32
		replayCount    int32
	}
	metricsMap := make(map[string]inputMetrics, len(req.GetResponses()))
	for _, respInput := range req.GetResponses() {
		metricsMap[respInput.GetInteractionId()] = inputMetrics{
			timeToAnswerMs: respInput.GetTimeToAnswerMs(),
			replayCount:    respInput.GetReplayCount(),
		}
	}

	// Upsert attempt + responses in a transaction
	attempt, txErr := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (struct {
		attempt   gen.LessonAttempt
		responses []gen.ListAttemptResponsesRow
	}, error) {
		// Prefer the server-authoritative watch fraction derived from the
		// coverage bitmap. WatchCoverageFraction returns -1 when the lesson
		// duration is unknown (no usable data), in which case we fall back to
		// the client-reported fraction. The SQL keeps GREATEST(old, new) across
		// retakes, so this is now a max of honest fractions.
		watchFrac := pgtype.Float4{}
		serverFrac := float64(-1)
		if s.kv != nil && lesson.DurationSeconds.Valid {
			if sf, ferr := kv.WatchCoverageFraction(s.kv, claims.Sub, lessonID.String(), int(lesson.DurationSeconds.Int32)); ferr == nil {
				serverFrac = sf
			} else {
				s.log.WarnContext(ctx, "interactions: watch coverage fraction failed, falling back to client value",
					"lesson_id", lessonID.String(), "err", ferr)
			}
		}
		if serverFrac >= 0 {
			watchFrac = pgtype.Float4{Float32: float32(serverFrac), Valid: true}
		} else if f := req.GetVideoWatchFraction(); f >= 0 {
			watchFrac = pgtype.Float4{Float32: float32(f), Valid: true}
		}
		a, err := q.UpsertLessonAttempt(ctx, gen.UpsertLessonAttemptParams{
			LessonID:           lessonID,
			UserID:             userID,
			TotalScore:         totalScore,
			MaxScore:           totalMaxScore,
			Status:             "submitted",
			VideoWatchFraction: watchFrac,
			ShouldIncrement:    shouldIncrement,
		})
		if err != nil {
			return struct {
				attempt   gen.LessonAttempt
				responses []gen.ListAttemptResponsesRow
			}{}, fmt.Errorf("upsert attempt: %w", err)
		}

		for _, g := range graded {
			m := metricsMap[g.interactionID.String()]
			ttaMs := pgtype.Int4{}
			if m.timeToAnswerMs > 0 {
				ttaMs = pgtype.Int4{Int32: m.timeToAnswerMs, Valid: true}
			}
			if err := q.UpsertAttemptResponse(ctx, gen.UpsertAttemptResponseParams{
				AttemptID:      a.ID,
				InteractionID:  g.interactionID,
				Response:       g.responseJSON,
				Score:          g.score,
				MaxScore:       g.maxScore,
				Feedback:       g.feedback,
				TimeToAnswerMs: ttaMs,
				ReplayCount:    m.replayCount,
			}); err != nil {
				return struct {
					attempt   gen.LessonAttempt
					responses []gen.ListAttemptResponsesRow
				}{}, fmt.Errorf("upsert response: %w", err)
			}
		}

		rs, err := q.ListAttemptResponses(ctx, a.ID)
		if err != nil {
			return struct {
				attempt   gen.LessonAttempt
				responses []gen.ListAttemptResponsesRow
			}{}, err
		}
		return struct {
			attempt   gen.LessonAttempt
			responses []gen.ListAttemptResponsesRow
		}{a, rs}, nil
	})
	if txErr != nil {
		return nil, svc.ConnectDBError(txErr)
	}

	if s.kv != nil {
		go func() {
			for _, respInput := range req.GetResponses() {
				_ = s.kv.Delete("temp_grade", tuple.Tuple{claims.Sub, lessonID.String(), respInput.GetInteractionId()})
			}
		}()
	}

	// Best-effort async deletion of old student audio recordings.
	if len(oldAudioKeys) > 0 && s.deleteAudio != nil {
		deleter := s.deleteAudio
		go func() {
			bgCtx := context.Background()
			for _, key := range oldAudioKeys {
				_ = deleter(bgCtx, key)
			}
		}()
	}

	return &richterv1.SubmitAttemptResponse{
		Attempt: AttemptToProto(attempt.attempt, attempt.responses),
	}, nil
}

// ── PreviewGrade ──────────────────────────────────────────────────────────────

// PreviewGrade grades a single response for AFTER_EACH feedback. The result is
// cached so SubmitAttempt can reuse it when the final response has not changed.
func (s *InteractionsSvc) PreviewGrade(
	ctx context.Context,
	req *richterv1.PreviewGradeRequest,
) (*richterv1.PreviewGradeResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	target, err := s.lookupSingleGradeTarget(ctx, lessonID, req.GetResponse())
	if err != nil {
		return nil, err
	}
	if _, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID); err != nil {
		return nil, err
	}
	if target.lesson.FeedbackMode != "after_each" {
		if _, err := s.authz.RequireOrgRole(ctx, target.orgID,
			gen.OrganizationRoleOwner, gen.OrganizationRoleAdmin, gen.OrganizationRoleTeacher,
		); err != nil {
			return nil, connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("preview grading only allowed when feedback_mode is after_each"))
		}
	}
	result, err := s.gradeSingleResponse(ctx, lessonID, target)
	if err != nil {
		// Includes context.DeadlineExceeded from the timeout above AND any
		// panic recovered just above. Always return a graceful pending
		// response so the FE never renders a hard error during inline grading.
		s.log.WarnContext(ctx, "interactions: PreviewGrade fell through to graceful pending response",
			"interaction_id", req.GetResponse().GetInteractionId(), "err", err)
		return &richterv1.PreviewGradeResponse{
			Score: 0.5, MaxScore: 1.0,
			Feedback: "Đang chấm điểm — kết quả tạm thời sẽ được cập nhật khi bạn nộp bài.",
		}, nil
	}

	s.cacheGrade(claims.Sub, lessonID, req.GetResponse().GetInteractionId(), target.responseJSON, result)

	return &richterv1.PreviewGradeResponse{Score: result.score, MaxScore: result.maxScore, Feedback: result.feedback}, nil
}

// ── SaveAttemptResponse ────────────────────────────────────────────────────────

func (s *InteractionsSvc) SaveAttemptResponse(
	ctx context.Context,
	req *richterv1.SaveAttemptResponseRequest,
) (*richterv1.SaveAttemptResponseResponse, error) {
	claims, err := s.authz.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	target, err := s.lookupSingleGradeTarget(ctx, lessonID, req.GetResponse())
	if err != nil {
		return nil, err
	}
	if _, err := s.authz.RequireCourseMemberByLesson(ctx, lessonID); err != nil {
		return nil, err
	}

	result, err := s.gradeSingleResponse(ctx, lessonID, target)
	if err != nil {
		s.log.WarnContext(ctx, "interactions: SaveAttemptResponse grade failed, caching pending credit",
			"interaction_id", req.GetResponse().GetInteractionId(), "err", err)
		result = singleGradeResult{
			score:    0.5,
			maxScore: 1,
			feedback: "Đang chấm điểm — kết quả tạm thời sẽ được cập nhật khi bạn nộp bài.",
		}
	}
	s.cacheGrade(claims.Sub, lessonID, req.GetResponse().GetInteractionId(), target.responseJSON, result)

	if target.lesson.FeedbackMode != "after_each" {
		return &richterv1.SaveAttemptResponseResponse{FeedbackRevealed: false}, nil
	}
	return &richterv1.SaveAttemptResponseResponse{
		Score:            result.score,
		MaxScore:         result.maxScore,
		Feedback:         result.feedback,
		FeedbackRevealed: true,
	}, nil
}
