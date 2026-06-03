package interactions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// AIRegenerateFunc is provided by the AI service via DI to allow InteractionsSvc
// to regenerate a single interaction using Gemini without a direct import cycle.
type AIRegenerateFunc func(ctx context.Context, interactionID pgtype.UUID, newKind richterv1.InteractionKind, customPrompt string) (*gen.LessonInteraction, error)

// GradingDepsProvider is provided by the AI service via DI to supply external
// grading dependencies (audio AI, S3 download) for ContextualGrader handlers.
type GradingDepsProvider func(ctx context.Context, lessonID pgtype.UUID) (GradingDeps, error)

// AudioObjectDeleter is provided by the AI service via DI.
// It deletes a student audio recording from S3 (best-effort; used after retake).
type AudioObjectDeleter func(ctx context.Context, objectKey string) error

var Package = do.Package(
	do.Lazy(NewInteractionsSvc),
)

func init() {
	Package(internal.Injector)
}

type tempGradeCache struct {
	ResponseJSON []byte  `json:"response_json"`
	Score        float32 `json:"score"`
	MaxScore     float32 `json:"max_score"`
	Feedback     string  `json:"feedback"`
}

type singleGradeTarget struct {
	orgID         pgtype.UUID
	lesson        gen.Lesson
	interaction   gen.LessonInteraction
	interactionID pgtype.UUID
	responseJSON  []byte
	handler       Handler
}

type singleGradeResult struct {
	score    float32
	maxScore float32
	feedback string
}

type InteractionsSvc struct {
	pg          *db.PostgresSvc
	kv          *kv.KVSvc
	log         *log.LogSvc
	authz       *authz.AuthzSvc
	aiRegen     AIRegenerateFunc    // injected by AISvc; nil in test/unit contexts
	gradingDeps GradingDepsProvider // injected by AISvc; nil in test/unit contexts
	deleteAudio AudioObjectDeleter  // injected by AISvc; nil in test/unit contexts
}

var _ richterv1connect.InteractionServiceHandler = (*InteractionsSvc)(nil)

// errPreviewGradePanicked is returned (in-band) by the PreviewGrade recover()
// branch so the surrounding error-handling code path can convert it into a
// graceful "pending" response.
var errPreviewGradePanicked = errors.New("PreviewGrade panicked")

func NewInteractionsSvc(i do.Injector) (*InteractionsSvc, error) {
	pg, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc: %w", err)
	}
	kvSvc, _ := do.Invoke[*kv.KVSvc](i)
	lg, err := do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc: %w", err)
	}
	az, err := do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc: %w", err)
	}
	// Optional: AI regeneration + grading deps + audio deleter provided by AISvc. Nil-safe.
	aiRegen, _ := do.Invoke[AIRegenerateFunc](i)
	gradingDeps, _ := do.Invoke[GradingDepsProvider](i)
	deleteAudio, _ := do.Invoke[AudioObjectDeleter](i)
	return &InteractionsSvc{pg: pg, kv: kvSvc, log: lg, authz: az, aiRegen: aiRegen, gradingDeps: gradingDeps, deleteAudio: deleteAudio}, nil
}

func (s *InteractionsSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewInteractionServiceHandler(
		s,
		connect.WithInterceptors(validate.NewInterceptor(), s.authz.Interceptor()),
	)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func (s *InteractionsSvc) requireTeacherRole(ctx context.Context, lessonID pgtype.UUID) error {
	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return svc.ConnectDBError(err)
	}
	_, err = s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
	)
	return err
}

func (s *InteractionsSvc) lookupSingleGradeTarget(
	ctx context.Context,
	lessonID pgtype.UUID,
	respInput *richterv1.AttemptResponseInput,
) (singleGradeTarget, error) {
	if respInput == nil {
		return singleGradeTarget{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("response required"))
	}
	interactionID, err := svc.ParseUUID(respInput.GetInteractionId())
	if err != nil {
		return singleGradeTarget{}, err
	}

	type lookup struct {
		orgID       pgtype.UUID
		lesson      gen.Lesson
		interaction gen.LessonInteraction
	}
	got, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (lookup, error) {
		orgID, err := q.GetOrgIDByLessonID(ctx, lessonID)
		if err != nil {
			return lookup{}, err
		}
		lesson, err := q.GetLessonByID(ctx, lessonID)
		if err != nil {
			return lookup{}, err
		}
		interaction, err := q.GetLessonInteractionByID(ctx, interactionID)
		if err != nil {
			return lookup{}, err
		}
		return lookup{orgID: orgID, lesson: lesson, interaction: interaction}, nil
	})
	if err != nil {
		return singleGradeTarget{}, svc.ConnectDBError(err)
	}
	if got.interaction.LessonID.String() != lessonID.String() {
		return singleGradeTarget{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("interaction does not belong to lesson"))
	}

	kind := dbStringToKind(got.interaction.Kind)
	h := Get(kind)
	if h == nil {
		return singleGradeTarget{}, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no handler for interaction kind %q", got.interaction.Kind))
	}
	responseJSON, err := h.ResponseProtoToJSON(respInput)
	if err != nil {
		return singleGradeTarget{}, err
	}

	return singleGradeTarget{
		orgID:         got.orgID,
		lesson:        got.lesson,
		interaction:   got.interaction,
		interactionID: interactionID,
		responseJSON:  responseJSON,
		handler:       h,
	}, nil
}

func (s *InteractionsSvc) gradeSingleResponse(
	ctx context.Context,
	lessonID pgtype.UUID,
	target singleGradeTarget,
) (result singleGradeResult, err error) {
	gradeCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	defer func() {
		if r := recover(); r != nil {
			s.log.ErrorContext(ctx, "interactions: panic in single response grade",
				"interaction_id", target.interactionID.String(), "recover", r)
			err = errPreviewGradePanicked
		}
	}()

	if cg, ok := target.handler.(ContextualGrader); ok && s.gradingDeps != nil {
		deps, derr := s.gradingDeps(gradeCtx, lessonID)
		if derr != nil {
			return singleGradeResult{}, fmt.Errorf("resolve grading deps: %w", derr)
		}
		score, maxScore, feedback, gerr := cg.GradeWithContext(gradeCtx, deps, target.interaction.Config, target.responseJSON)
		return singleGradeResult{score: score, maxScore: maxScore, feedback: feedback}, gerr
	}

	score, maxScore, feedback, gerr := target.handler.Grade(target.interaction.Config, target.responseJSON)
	return singleGradeResult{score: score, maxScore: maxScore, feedback: feedback}, gerr
}

func (s *InteractionsSvc) cacheGrade(claimsSub string, lessonID pgtype.UUID, interactionID string, responseJSON []byte, result singleGradeResult) {
	if s.kv == nil {
		return
	}
	cacheData := tempGradeCache{
		ResponseJSON: responseJSON,
		Score:        result.score,
		MaxScore:     result.maxScore,
		Feedback:     result.feedback,
	}
	if cacheBytes, err := json.Marshal(cacheData); err == nil {
		_ = s.kv.Set("temp_grade", tuple.Tuple{claimsSub, lessonID.String(), interactionID}, cacheBytes)
	}
}

// ── ListLessonInteractions ────────────────────────────────────────────────────

func (s *InteractionsSvc) ListLessonInteractions(
	ctx context.Context,
	req *richterv1.ListLessonInteractionsRequest,
) (*richterv1.ListLessonInteractionsResponse, error) {
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
	isTeacher := false
	if _, err := s.authz.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner, gen.OrganizationRoleAdmin, gen.OrganizationRoleTeacher,
	); err == nil {
		isTeacher = true
	} else if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	limit := req.GetLimit()
	if limit == 0 {
		limit = 500
	}
	rows, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
			LessonID: lessonID, Limit: limit, Offset: req.GetOffset(),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	out := make([]*richterv1.LessonInteraction, 0, len(rows))
	for _, r := range rows {
		out = append(out, InteractionToProto(r, !isTeacher))
	}
	return &richterv1.ListLessonInteractionsResponse{Interactions: out}, nil
}

// ── CreateManualInteraction ───────────────────────────────────────────────────

func (s *InteractionsSvc) CreateManualInteraction(
	ctx context.Context,
	req *richterv1.CreateManualInteractionRequest,
) (*richterv1.CreateManualInteractionResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}

	// Determine kind from the config oneof
	var kind richterv1.InteractionKind
	switch req.Config.(type) {
	case *richterv1.CreateManualInteractionRequest_Mcq:
		mcqCfg := req.Config.(*richterv1.CreateManualInteractionRequest_Mcq).Mcq
		if mcqCfg != nil && len(mcqCfg.CorrectAnswers) > 0 {
			kind = richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE
		} else {
			kind = richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE
		}
	case *richterv1.CreateManualInteractionRequest_FillBlank:
		kind = richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK
	case *richterv1.CreateManualInteractionRequest_Listening:
		kind = richterv1.InteractionKind_INTERACTION_KIND_LISTENING
	case *richterv1.CreateManualInteractionRequest_Reading:
		kind = richterv1.InteractionKind_INTERACTION_KIND_READING
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported interaction config type"))
	}

	h := Get(kind)
	if h == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no handler for kind %v", kind))
	}
	configJSON, err := h.ConfigFromCreateProto(req)
	if err != nil {
		return nil, err
	}

	created, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.LessonInteraction, error) {
		nextIdx, err := q.GetLessonInteractionNextOrderIndex(ctx, lessonID)
		if err != nil {
			return gen.LessonInteraction{}, fmt.Errorf("compute order_index: %w", err)
		}
		chunkID := pgtype.UUID{}
		if id := req.GetChunkId(); id != "" {
			if parsed, parseErr := svc.ParseUUID(id); parseErr == nil {
				chunkID = parsed
			}
		}
		return q.InsertLessonInteraction(ctx, gen.InsertLessonInteractionParams{
			LessonID:     lessonID,
			ChunkID:      chunkID,
			Kind:         kindToDBString(kind),
			StartSeconds: float32(req.GetStartSeconds()),
			OrderIndex:   nextIdx,
			Prompt:       req.GetPrompt(),
			Explanation:  req.GetExplanation(),
			Config:       configJSON,
			MaxScore:     1.0,
			GeneratedBy:  "manual",
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.CreateManualInteractionResponse{Interaction: InteractionToProto(created, false)}, nil
}

// ── UpdateInteraction ─────────────────────────────────────────────────────────

func (s *InteractionsSvc) UpdateInteraction(
	ctx context.Context,
	req *richterv1.UpdateInteractionRequest,
) (*richterv1.UpdateInteractionResponse, error) {
	interactionID, err := svc.ParseUUID(req.GetInteractionId())
	if err != nil {
		return nil, err
	}

	existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.GetLessonInteractionByID(ctx, interactionID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, existing.LessonID); err != nil {
		return nil, err
	}

	// Determine kind from config oneof (default to existing kind)
	var configJSON []byte
	kind := dbStringToKind(existing.Kind)

	switch req.Config.(type) {
	case *richterv1.UpdateInteractionRequest_Mcq:
		mcqCfg := req.Config.(*richterv1.UpdateInteractionRequest_Mcq).Mcq
		if mcqCfg != nil && len(mcqCfg.CorrectAnswers) > 0 {
			kind = richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE
		} else {
			kind = richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE
		}
		h := Get(kind)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no MCQ handler for %v", kind))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case *richterv1.UpdateInteractionRequest_FillBlank:
		kind = richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK
		h := Get(kind)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no fill_blank handler"))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case *richterv1.UpdateInteractionRequest_Listening:
		kind = richterv1.InteractionKind_INTERACTION_KIND_LISTENING
		h := Get(kind)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no listening handler"))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case *richterv1.UpdateInteractionRequest_Reading:
		kind = richterv1.InteractionKind_INTERACTION_KIND_READING
		h := Get(kind)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no reading handler"))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case nil:
		// No config change — keep existing config
		configJSON = existing.Config
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unsupported interaction config type"))
	}

	updated, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.UpdateLessonInteraction(ctx, gen.UpdateLessonInteractionParams{
			ID:           interactionID,
			Prompt:       req.GetPrompt(),
			Explanation:  req.GetExplanation(),
			StartSeconds: float32(req.GetStartSeconds()),
			Config:       configJSON,
			Kind:         kindToDBString(kind),
		})
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.UpdateInteractionResponse{Interaction: InteractionToProto(updated, false)}, nil
}

// ── DeleteInteraction ─────────────────────────────────────────────────────────

func (s *InteractionsSvc) DeleteInteraction(
	ctx context.Context,
	req *richterv1.DeleteInteractionRequest,
) (*richterv1.DeleteInteractionResponse, error) {
	interactionID, err := svc.ParseUUID(req.GetInteractionId())
	if err != nil {
		return nil, err
	}
	existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.GetLessonInteractionByID(ctx, interactionID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, existing.LessonID); err != nil {
		return nil, err
	}
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonInteraction(ctx, interactionID)
	}); err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.DeleteInteractionResponse{}, nil
}

func (s *InteractionsSvc) DeleteLessonInteractions(
	ctx context.Context,
	req *richterv1.DeleteLessonInteractionsRequest,
) (*richterv1.DeleteLessonInteractionsResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.requireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}

	chunkIDRaw := strings.TrimSpace(req.GetChunkId())
	if chunkIDRaw != "" {
		chunkID, err := svc.ParseUUID(chunkIDRaw)
		if err != nil {
			return nil, err
		}
		chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
			return q.GetLessonTranscriptChunk(ctx, chunkID)
		})
		if err != nil {
			return nil, svc.ConnectDBError(err)
		}
		if chunk.LessonID.String() != lessonID.String() {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunk does not belong to lesson"))
		}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			return q.DeleteLessonInteractionsByChunk(ctx, chunkID)
		}); err != nil {
			return nil, svc.ConnectDBError(err)
		}
		return &richterv1.DeleteLessonInteractionsResponse{}, nil
	}

	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonInteractionsByLesson(ctx, lessonID)
	}); err != nil {
		return nil, svc.ConnectDBError(err)
	}
	return &richterv1.DeleteLessonInteractionsResponse{}, nil
}

// ── SubmitAttempt ─────────────────────────────────────────────────────────────

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

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
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
			LessonID: lessonID, Limit: 500, Offset: 0,
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
				var cached tempGradeCache
				if json.Unmarshal(cachedBytes, &cached) == nil {
					if bytes.Equal(cached.ResponseJSON, responseJSON) {
						graded[idx].score = cached.Score
						graded[idx].maxScore = cached.MaxScore
						graded[idx].feedback = cached.Feedback
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

			gradeCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
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

	// Collect old audio keys to delete after upsert (best-effort cleanup on retake).
	var oldAudioKeys []string
	if s.deleteAudio != nil {
		if prevAttempt, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAttempt, error) {
			return q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{LessonID: lessonID, UserID: userID})
		}); err == nil {
			if prevResponses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.ListAttemptResponsesRow, error) {
				return q.ListAttemptResponses(ctx, prevAttempt.ID)
			}); err == nil {
				for _, pr := range prevResponses {
					interactionRow, ok := interactionByID[pr.InteractionID.String()]
					if !ok {
						continue
					}
					kind := dbStringToKind(interactionRow.Kind)
					h := Get(kind)
					if h == nil {
						continue
					}
					if ac, ok := h.(AudioObjectCleaner); ok {
						if key := ac.AudioObjectKeyFromResponse(pr.Response); key != "" {
							oldAudioKeys = append(oldAudioKeys, key)
						}
					}
				}
			}
		}
	}

	// Upsert attempt + responses in a transaction
	attempt, txErr := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (struct {
		attempt   gen.LessonAttempt
		responses []gen.ListAttemptResponsesRow
	}, error) {
		a, err := q.UpsertLessonAttempt(ctx, gen.UpsertLessonAttemptParams{
			LessonID:   lessonID,
			UserID:     userID,
			TotalScore: totalScore,
			MaxScore:   totalMaxScore,
			Status:     "submitted",
		})
		if err != nil {
			return struct {
				attempt   gen.LessonAttempt
				responses []gen.ListAttemptResponsesRow
			}{}, fmt.Errorf("upsert attempt: %w", err)
		}

		for _, g := range graded {
			if err := q.UpsertAttemptResponse(ctx, gen.UpsertAttemptResponseParams{
				AttemptID:     a.ID,
				InteractionID: g.interactionID,
				Response:      g.responseJSON,
				Score:         g.score,
				MaxScore:      g.maxScore,
				Feedback:      g.feedback,
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
	if _, err := s.authz.RequireOrgMember(ctx, target.orgID); err != nil {
		return nil, err
	}
	if target.lesson.FeedbackMode != "after_each" {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("preview grading only allowed when feedback_mode is after_each"))
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
	if _, err := s.authz.RequireOrgMember(ctx, target.orgID); err != nil {
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

// ── GetMyAttempt ──────────────────────────────────────────────────────────────

func (s *InteractionsSvc) GetMyAttempt(
	ctx context.Context,
	req *richterv1.GetMyAttemptRequest,
) (*richterv1.GetMyAttemptResponse, error) {
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

	orgID, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (pgtype.UUID, error) {
		return q.GetOrgIDByLessonID(ctx, lessonID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, orgID); err != nil {
		return nil, err
	}

	type result struct {
		attempt   gen.LessonAttempt
		responses []gen.ListAttemptResponsesRow
	}
	r, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (result, error) {
		a, err := q.GetMyLessonAttempt(ctx, gen.GetMyLessonAttemptParams{
			LessonID: lessonID,
			UserID:   userID,
		})
		if err != nil {
			return result{}, err
		}
		rs, err := q.ListAttemptResponses(ctx, a.ID)
		if err != nil {
			return result{}, err
		}
		return result{a, rs}, nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &richterv1.GetMyAttemptResponse{}, nil
		}
		return nil, svc.ConnectDBError(err)
	}

	return &richterv1.GetMyAttemptResponse{Attempt: AttemptToProto(r.attempt, r.responses)}, nil
}

// ── RegenerateInteraction ─────────────────────────────────────────────────────

func (s *InteractionsSvc) RegenerateInteraction(
	ctx context.Context,
	req *richterv1.RegenerateInteractionRequest,
) (*richterv1.RegenerateInteractionResponse, error) {
	if s.aiRegen == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("AI regeneration not available"))
	}
	interactionID, err := svc.ParseUUID(req.GetInteractionId())
	if err != nil {
		return nil, err
	}

	// Load interaction to verify auth via lesson.
	existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.GetLessonInteractionByID(ctx, interactionID)
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, existing.LessonID); err != nil {
		return nil, err
	}

	// Determine kind: use new_kind if specified, otherwise keep existing.
	newKind := req.GetNewKind()
	if newKind == richterv1.InteractionKind_INTERACTION_KIND_UNSPECIFIED {
		newKind = dbStringToKind(existing.Kind)
	}

	updated, err := s.aiRegen(ctx, interactionID, newKind, req.GetCustomPrompt())
	if err != nil {
		return nil, err
	}
	return &richterv1.RegenerateInteractionResponse{Interaction: InteractionToProto(*updated, false)}, nil
}

// ── ListAttempts ──────────────────────────────────────────────────────────────

func (s *InteractionsSvc) ListAttempts(
	ctx context.Context,
	req *richterv1.ListAttemptsRequest,
) (*richterv1.ListAttemptsResponse, error) {
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

	limit := req.GetLimit()
	if limit == 0 {
		limit = 50
	}

	type attemptsResult struct {
		rows  []gen.ListLessonAttemptsRow
		total int64
	}
	ar, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (attemptsResult, error) {
		rows, err := q.ListLessonAttempts(ctx, gen.ListLessonAttemptsParams{
			LessonID: lessonID, Limit: limit, Offset: req.GetOffset(),
		})
		if err != nil {
			return attemptsResult{}, err
		}
		total, err := q.CountLessonAttempts(ctx, lessonID)
		if err != nil {
			return attemptsResult{}, err
		}
		return attemptsResult{rows, total}, nil
	})
	if err != nil {
		return nil, svc.ConnectDBError(err)
	}

	summaries := make([]*richterv1.StudentAttemptSummary, 0, len(ar.rows))
	for _, r := range ar.rows {
		name := buildDisplayName(r.FirstName, r.MiddleName, r.LastName)
		var ts *timestamppb.Timestamp
		if r.SubmittedAt.Valid {
			ts = timestamppb.New(r.SubmittedAt.Time)
		}
		summaries = append(summaries, &richterv1.StudentAttemptSummary{
			UserId:       r.UserID.String(),
			DisplayName:  name,
			Email:        r.Email,
			TotalScore:   r.TotalScore,
			MaxScore:     r.MaxScore,
			SubmittedAt:  ts,
			AttemptCount: r.AttemptCount,
		})
	}

	return &richterv1.ListAttemptsResponse{
		Attempts: summaries,
		Total:    int32(ar.total),
	}, nil
}

func buildDisplayName(first string, middle pgtype.Text, last string) string {
	parts := []string{first}
	if middle.Valid && middle.String != "" {
		parts = append(parts, middle.String)
	}
	parts = append(parts, last)
	return strings.Join(parts, " ")
}
