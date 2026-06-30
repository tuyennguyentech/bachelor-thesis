package chunkops

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type RequireTeacherRoleFunc func(context.Context, pgtype.UUID) error
type LoadSegmentsFunc func(string) []segment.Segment
type FetchChunkTranscriptFunc func(string) string
type LimitFunc func() int32

type Deps struct {
	Postgres             *db.PostgresSvc
	KV                   *kv.KVSvc
	Log                  *log.LogSvc
	RequireTeacherRole   RequireTeacherRoleFunc
	LoadSegments         LoadSegmentsFunc
	FetchChunkTranscript FetchChunkTranscriptFunc
	ChunksLimit          LimitFunc
}

type Service struct {
	pg                   *db.PostgresSvc
	kv                   *kv.KVSvc
	log                  *log.LogSvc
	requireTeacherRole   RequireTeacherRoleFunc
	loadSegments         LoadSegmentsFunc
	fetchChunkTranscript FetchChunkTranscriptFunc
	chunksLimit          LimitFunc
}

type SplitResult struct {
	First  gen.LessonTranscriptChunk
	Second gen.LessonTranscriptChunk
}

type BoundaryResult struct {
	Prev gen.LessonTranscriptChunk
	Next gen.LessonTranscriptChunk
}

func New(deps Deps) *Service {
	return &Service{
		pg:                   deps.Postgres,
		kv:                   deps.KV,
		log:                  deps.Log,
		requireTeacherRole:   deps.RequireTeacherRole,
		loadSegments:         deps.LoadSegments,
		fetchChunkTranscript: deps.FetchChunkTranscript,
		chunksLimit:          deps.ChunksLimit,
	}
}

func (s *Service) Merge(
	ctx context.Context,
	req *richterv1.MergeChunksRequest,
) (gen.LessonTranscriptChunk, error) {
	keepID, err := svc.ParseUUID(req.GetKeepChunkId())
	if err != nil {
		return gen.LessonTranscriptChunk{}, err
	}
	discardID, err := svc.ParseUUID(req.GetDiscardChunkId())
	if err != nil {
		return gen.LessonTranscriptChunk{}, err
	}
	if keepID == discardID {
		return gen.LessonTranscriptChunk{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("keep and discard must be different chunks"))
	}

	keepChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, keepID)
	})
	if err != nil {
		return gen.LessonTranscriptChunk{}, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, keepChunk.LessonID); err != nil {
		return gen.LessonTranscriptChunk{}, err
	}

	discardChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, discardID)
	})
	if err != nil {
		return gen.LessonTranscriptChunk{}, svc.ConnectDBError(err)
	}
	if keepChunk.LessonID != discardChunk.LessonID {
		return gen.LessonTranscriptChunk{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunks must belong to the same lesson"))
	}

	diff := keepChunk.OrderIndex - discardChunk.OrderIndex
	if diff != 1 && diff != -1 {
		return gen.LessonTranscriptChunk{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("only adjacent chunks can be merged"))
	}

	keepTranscript := s.fetchChunkTranscript(keepID.String())
	discardTranscript := s.fetchChunkTranscript(discardID.String())
	mergedStart := min(keepChunk.StartSeconds, discardChunk.StartSeconds)
	mergedEnd := max(keepChunk.EndSeconds, discardChunk.EndSeconds)

	var mergedTranscript string
	if keepChunk.OrderIndex < discardChunk.OrderIndex {
		mergedTranscript = keepTranscript + "\n" + discardTranscript
	} else {
		mergedTranscript = discardTranscript + "\n" + keepTranscript
	}

	if err := segment.SaveChunkTranscript(s.kv, keepID.String(), mergedTranscript); err != nil {
		return gen.LessonTranscriptChunk{}, connect.NewError(connect.CodeInternal, fmt.Errorf("write merged transcript to FDB: %w", err))
	}

	var mergedChunk gen.LessonTranscriptChunk
	if err := db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) error {
		if err := q.DeleteLessonInteractionsByChunk(ctx, discardID); err != nil {
			return fmt.Errorf("delete discard questions: %w", err)
		}
		if err := q.DeleteLessonTranscriptChunk(ctx, discardID); err != nil {
			return fmt.Errorf("delete discard chunk: %w", err)
		}
		updated, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID:           keepID,
			StartSeconds: mergedStart,
			EndSeconds:   mergedEnd,
			Summary:      keepChunk.Summary,
		})
		if err != nil {
			return fmt.Errorf("update keep chunk boundaries: %w", err)
		}
		mergedChunk = updated
		return q.ReorderLessonChunks(ctx, keepChunk.LessonID)
	}); err != nil {
		return gen.LessonTranscriptChunk{}, connect.NewError(connect.CodeInternal, fmt.Errorf("merge chunks: %w", err))
	}

	_ = segment.DeleteChunkTranscript(s.kv, discardID.String())
	return mergedChunk, nil
}

func (s *Service) Delete(
	ctx context.Context,
	req *richterv1.DeleteChunkRequest,
) error {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return err
	}

	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		return svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, chunk.LessonID); err != nil {
		return err
	}

	if err := db.WithCommitTxExec(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) error {
		if err := q.DeleteLessonInteractionsByChunk(ctx, chunkID); err != nil {
			return fmt.Errorf("delete questions: %w", err)
		}
		if err := q.DeleteLessonTranscriptChunk(ctx, chunkID); err != nil {
			return fmt.Errorf("delete chunk: %w", err)
		}
		return q.ReorderLessonChunks(ctx, chunk.LessonID)
	}); err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("delete chunk: %w", err))
	}

	_ = segment.DeleteChunkTranscript(s.kv, chunkID.String())
	return nil
}

func (s *Service) Split(
	ctx context.Context,
	req *richterv1.SplitChunkRequest,
) (SplitResult, error) {
	chunkID, err := svc.ParseUUID(req.GetChunkId())
	if err != nil {
		return SplitResult{}, err
	}
	splitAt := float32(req.GetSplitAtSeconds())

	chunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, chunkID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SplitResult{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("chunk not found"))
		}
		return SplitResult{}, svc.ConnectDBError(err)
	}
	if err := s.requireTeacherRole(ctx, chunk.LessonID); err != nil {
		return SplitResult{}, err
	}
	if splitAt <= float32(chunk.StartSeconds) || splitAt >= float32(chunk.EndSeconds) {
		return SplitResult{}, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("split_at_seconds %.1f must be within (%.1f, %.1f)", splitAt, chunk.StartSeconds, chunk.EndSeconds))
	}

	allSegs := s.loadSegments(chunk.LessonID.String())
	firstTranscript := segment.BuildChunkTranscript(allSegs, float32(chunk.StartSeconds), splitAt)
	secondTranscript := segment.BuildChunkTranscript(allSegs, splitAt, float32(chunk.EndSeconds))

	type splitTxResult struct {
		first       gen.LessonTranscriptChunk
		second      gen.LessonTranscriptChunk
		secondNewID pgtype.UUID
	}
	result, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (splitTxResult, error) {
		updated, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID: chunk.ID, StartSeconds: chunk.StartSeconds,
			EndSeconds: float64(splitAt), Summary: chunk.Summary,
		})
		if err != nil {
			return splitTxResult{}, svc.ConnectDBError(err)
		}

		existingChunks, err := q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: chunk.LessonID, Limit: s.chunksLimit(), Offset: 0})
		if err != nil {
			return splitTxResult{}, svc.ConnectDBError(err)
		}
		maxOrder := int32(0)
		for _, c := range existingChunks {
			if c.OrderIndex > maxOrder {
				maxOrder = c.OrderIndex
			}
		}
		newChunk, err := q.InsertLessonTranscriptChunk(ctx, gen.InsertLessonTranscriptChunkParams{
			LessonID: chunk.LessonID, OrderIndex: maxOrder + 1,
			StartSeconds: float64(splitAt), EndSeconds: chunk.EndSeconds,
			Summary: chunk.Summary, QuestionCountConfig: chunk.QuestionCountConfig,
		})
		if err != nil {
			return splitTxResult{}, svc.ConnectDBError(err)
		}

		if err := q.ReorderLessonChunks(ctx, chunk.LessonID); err != nil {
			return splitTxResult{}, fmt.Errorf("reorder chunks after split: %w", err)
		}

		first, err := q.GetLessonTranscriptChunk(ctx, updated.ID)
		if err != nil {
			return splitTxResult{}, fmt.Errorf("re-fetch first chunk after split: %w", err)
		}
		second, err := q.GetLessonTranscriptChunk(ctx, newChunk.ID)
		if err != nil {
			return splitTxResult{}, fmt.Errorf("re-fetch second chunk after split: %w", err)
		}
		return splitTxResult{first: first, second: second, secondNewID: newChunk.ID}, nil
	})
	if err != nil {
		return SplitResult{}, err
	}

	if firstTranscript != "" {
		if err := segment.SaveChunkTranscript(s.kv, chunk.ID.String(), firstTranscript); err != nil {
			s.log.WarnContext(ctx, "ai: SplitChunk first chunk FDB write failed",
				"chunk_id", chunk.ID.String(), "err", err)
		}
	}
	if secondTranscript != "" {
		if err := segment.SaveChunkTranscript(s.kv, result.secondNewID.String(), secondTranscript); err != nil {
			s.log.WarnContext(ctx, "ai: SplitChunk second chunk FDB write failed — transcript lost",
				"chunk_id", result.secondNewID.String(), "err", err)
		}
	}

	return SplitResult{First: result.first, Second: result.second}, nil
}

func (s *Service) AdjustBoundary(
	ctx context.Context,
	req *richterv1.AdjustChunkBoundaryRequest,
) (BoundaryResult, error) {
	prevID, err := svc.ParseUUID(req.GetPrevChunkId())
	if err != nil {
		return BoundaryResult{}, err
	}
	nextID, err := svc.ParseUUID(req.GetNextChunkId())
	if err != nil {
		return BoundaryResult{}, err
	}
	newBoundary := float32(req.GetNewBoundarySeconds())

	prevChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, prevID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BoundaryResult{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("prev chunk not found"))
		}
		return BoundaryResult{}, svc.ConnectDBError(err)
	}
	nextChunk, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.GetLessonTranscriptChunk(ctx, nextID)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BoundaryResult{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("next chunk not found"))
		}
		return BoundaryResult{}, svc.ConnectDBError(err)
	}
	if prevChunk.LessonID != nextChunk.LessonID {
		return BoundaryResult{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunks belong to different lessons"))
	}
	if prevChunk.OrderIndex+1 != nextChunk.OrderIndex {
		return BoundaryResult{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("chunks are not adjacent (order_index %d and %d)", prevChunk.OrderIndex, nextChunk.OrderIndex))
	}
	if err := s.requireTeacherRole(ctx, prevChunk.LessonID); err != nil {
		return BoundaryResult{}, err
	}
	if newBoundary <= float32(prevChunk.StartSeconds) || newBoundary >= float32(nextChunk.EndSeconds) {
		return BoundaryResult{}, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("new_boundary_seconds %.1f must be within (%.1f, %.1f)",
				newBoundary, prevChunk.StartSeconds, nextChunk.EndSeconds))
	}

	allSegs := s.loadSegments(prevChunk.LessonID.String())
	prevTranscript := segment.BuildChunkTranscript(allSegs, float32(prevChunk.StartSeconds), newBoundary)
	nextTranscript := segment.BuildChunkTranscript(allSegs, newBoundary, float32(nextChunk.EndSeconds))

	result, err := db.WithCommitTx(s.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (BoundaryResult, error) {
		currentPrev, err := q.GetLessonTranscriptChunk(ctx, prevID)
		if err != nil {
			return BoundaryResult{}, svc.ConnectDBError(err)
		}
		currentNext, err := q.GetLessonTranscriptChunk(ctx, nextID)
		if err != nil {
			return BoundaryResult{}, svc.ConnectDBError(err)
		}
		if currentPrev.OrderIndex+1 != currentNext.OrderIndex {
			return BoundaryResult{}, connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("chunks are no longer adjacent — another edit may have changed their order"))
		}
		updPrev, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID: prevID, StartSeconds: currentPrev.StartSeconds, EndSeconds: float64(newBoundary), Summary: currentPrev.Summary,
		})
		if err != nil {
			return BoundaryResult{}, svc.ConnectDBError(err)
		}
		updNext, err := q.UpdateChunkMetadata(ctx, gen.UpdateChunkMetadataParams{
			ID: nextID, StartSeconds: float64(newBoundary), EndSeconds: currentNext.EndSeconds, Summary: currentNext.Summary,
		})
		if err != nil {
			return BoundaryResult{}, svc.ConnectDBError(err)
		}
		return BoundaryResult{Prev: updPrev, Next: updNext}, nil
	})
	if err != nil {
		return BoundaryResult{}, err
	}

	if prevTranscript != "" {
		if err := segment.SaveChunkTranscript(s.kv, prevID.String(), prevTranscript); err != nil {
			s.log.WarnContext(ctx, "ai: AdjustChunkBoundary prev chunk FDB write failed",
				"chunk_id", prevID.String(), "err", err)
		}
	}
	if nextTranscript != "" {
		if err := segment.SaveChunkTranscript(s.kv, nextID.String(), nextTranscript); err != nil {
			s.log.WarnContext(ctx, "ai: AdjustChunkBoundary next chunk FDB write failed",
				"chunk_id", nextID.String(), "err", err)
		}
	}

	return result, nil
}
