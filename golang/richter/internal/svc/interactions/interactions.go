package interactions

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
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

type InteractionsSvc struct {
	pg          *db.PostgresSvc
	kv          *kv.KVSvc
	log         *log.LogSvc
	authz       *authz.AuthzSvc
	intCfg      *cfg.InteractionsCfg
	aiRegen     AIRegenerateFunc    // injected by AISvc; nil in test/unit contexts
	gradingDeps GradingDepsProvider // injected by AISvc; nil in test/unit contexts
	deleteAudio AudioObjectDeleter  // injected by AISvc; nil in test/unit contexts
}

var _ richterv1connect.InteractionServiceHandler = (*InteractionsSvc)(nil)

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
	intCfg, err := do.Invoke[*cfg.InteractionsCfg](i)
	if err != nil {
		return nil, fmt.Errorf("InteractionsCfg: %w", err)
	}
	// Optional: AI regeneration + grading deps + audio deleter provided by AISvc. Nil-safe.
	aiRegen, _ := do.Invoke[AIRegenerateFunc](i)
	gradingDeps, _ := do.Invoke[GradingDepsProvider](i)
	deleteAudio, _ := do.Invoke[AudioObjectDeleter](i)
	return &InteractionsSvc{pg: pg, kv: kvSvc, log: lg, authz: az, intCfg: intCfg, aiRegen: aiRegen, gradingDeps: gradingDeps, deleteAudio: deleteAudio}, nil
}

// aiCtx returns a child of ctx with the given timeout, or returns ctx
// unchanged when d is 0 (unlimited). Clamps negative values to 0.
func (s *InteractionsSvc) aiCtx(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, d)
}

// listLimit returns the configured interaction list page size as int32
// (sqlc param type), falling back to 500 when unset.
func (s *InteractionsSvc) listLimit() int32 {
	if s.intCfg == nil || s.intCfg.ListLimit <= 0 {
		return 500
	}
	return int32(s.intCfg.ListLimit)
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
	case *richterv1.CreateManualInteractionRequest_Writing:
		kind = richterv1.InteractionKind_INTERACTION_KIND_WRITING
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
	case *richterv1.UpdateInteractionRequest_Writing:
		kind = richterv1.InteractionKind_INTERACTION_KIND_WRITING
		h := Get(kind)
		if h == nil {
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no writing handler"))
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
