package interactions

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// AIRegenerateFunc is provided by the AI service via DI to allow InteractionsSvc
// to regenerate a single interaction using Gemini without a direct import cycle.
type AIRegenerateFunc func(ctx context.Context, interactionID pgtype.UUID, newKind richterv1.InteractionKind) (*gen.LessonInteraction, error)

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

type InteractionsSvc struct {
	pg           *db.PostgresSvc
	authz        *authz.AuthzSvc
	aiRegen      AIRegenerateFunc    // injected by AISvc; nil in test/unit contexts
	gradingDeps  GradingDepsProvider // injected by AISvc; nil in test/unit contexts
	deleteAudio  AudioObjectDeleter  // injected by AISvc; nil in test/unit contexts
}

var _ richterv1connect.InteractionServiceHandler = (*InteractionsSvc)(nil)

func NewInteractionsSvc(i do.Injector) (*InteractionsSvc, error) {
	pg, err := do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc: %w", err)
	}
	az, err := do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc: %w", err)
	}
	// Optional: AI regeneration + grading deps + audio deleter provided by AISvc. Nil-safe.
	aiRegen, _ := do.Invoke[AIRegenerateFunc](i)
	gradingDeps, _ := do.Invoke[GradingDepsProvider](i)
	deleteAudio, _ := do.Invoke[AudioObjectDeleter](i)
	return &InteractionsSvc{pg: pg, authz: az, aiRegen: aiRegen, gradingDeps: gradingDeps, deleteAudio: deleteAudio}, nil
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
		kind = richterv1.InteractionKind_INTERACTION_KIND_MCQ
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
	switch req.Config.(type) {
	case *richterv1.UpdateInteractionRequest_Mcq:
		h := Get(richterv1.InteractionKind_INTERACTION_KIND_MCQ)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no MCQ handler"))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case *richterv1.UpdateInteractionRequest_FillBlank:
		h := Get(richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no fill_blank handler"))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case *richterv1.UpdateInteractionRequest_Listening:
		h := Get(richterv1.InteractionKind_INTERACTION_KIND_LISTENING)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no listening handler"))
		}
		configJSON, err = h.ConfigFromUpdateProto(req)
		if err != nil {
			return nil, err
		}
	case *richterv1.UpdateInteractionRequest_Reading:
		h := Get(richterv1.InteractionKind_INTERACTION_KIND_READING)
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

	// Lazily resolve grading deps once if any ContextualGrader is needed.
	var depsResolved bool
	var deps GradingDeps

	var totalScore, totalMaxScore float32
	var graded []gradedResponse

	for _, respInput := range req.GetResponses() {
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

		var score, maxScore float32
		var feedback string
		if cg, ok := h.(ContextualGrader); ok && s.gradingDeps != nil {
			if !depsResolved {
				d, derr := s.gradingDeps(ctx, lessonID)
				if derr != nil {
					return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("resolve grading deps: %w", derr))
				}
				deps = d
				depsResolved = true
			}
			score, maxScore, feedback, err = cg.GradeWithContext(ctx, deps, interaction.Config, responseJSON)
		} else {
			score, maxScore, feedback, err = h.Grade(interaction.Config, responseJSON)
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("grade interaction %s: %w", respInput.GetInteractionId(), err))
		}

		iid, err := svc.ParseUUID(respInput.GetInteractionId())
		if err != nil {
			return nil, err
		}
		graded = append(graded, gradedResponse{
			interactionID: iid,
			responseJSON:  responseJSON,
			score:         score,
			maxScore:      maxScore,
			feedback:      feedback,
		})
		totalScore += score
		totalMaxScore += maxScore
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

// PreviewGrade grades a single response without persisting it. Used by the
// AFTER_EACH feedback flow on the student side for interactions whose grading
// requires a server roundtrip (e.g. reading audio → Gemini).
func (s *InteractionsSvc) PreviewGrade(
	ctx context.Context,
	req *richterv1.PreviewGradeRequest,
) (*richterv1.PreviewGradeResponse, error) {
	if _, err := s.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	respInput := req.GetResponse()
	if respInput == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("response required"))
	}
	interactionID, err := svc.ParseUUID(respInput.GetInteractionId())
	if err != nil {
		return nil, err
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
		return nil, svc.ConnectDBError(err)
	}
	if _, err := s.authz.RequireOrgMember(ctx, got.orgID); err != nil {
		return nil, err
	}
	if got.lesson.FeedbackMode != "after_each" {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("preview grading only allowed when feedback_mode is after_each"))
	}
	if got.interaction.LessonID.String() != lessonID.String() {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("interaction does not belong to lesson"))
	}
	interaction := got.interaction

	kind := dbStringToKind(interaction.Kind)
	h := Get(kind)
	if h == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no handler for interaction kind %q", interaction.Kind))
	}

	responseJSON, err := h.ResponseProtoToJSON(respInput)
	if err != nil {
		return nil, err
	}

	var score, maxScore float32
	var feedback string
	if cg, ok := h.(ContextualGrader); ok && s.gradingDeps != nil {
		deps, derr := s.gradingDeps(ctx, lessonID)
		if derr != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("resolve grading deps: %w", derr))
		}
		score, maxScore, feedback, err = cg.GradeWithContext(ctx, deps, interaction.Config, responseJSON)
	} else {
		score, maxScore, feedback, err = h.Grade(interaction.Config, responseJSON)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("grade interaction: %w", err))
	}

	return &richterv1.PreviewGradeResponse{Score: score, MaxScore: maxScore, Feedback: feedback}, nil
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

	updated, err := s.aiRegen(ctx, interactionID, newKind)
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
			UserId:      r.UserID.String(),
			DisplayName: name,
			Email:       r.Email,
			TotalScore:  r.TotalScore,
			MaxScore:    r.MaxScore,
			SubmittedAt: ts,
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
