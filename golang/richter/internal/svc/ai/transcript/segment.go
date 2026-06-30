package transcript

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgxpool"
)

// UpdateSegment edits one segment of a lesson's transcript in place. The
// caller must be a teacher. After saving the edited segment we also:
//
//   - rebuild the lesson's flattened transcript text so the chunk pipeline
//     sees the new wording on the next run, and
//   - rebuild each affected chunk's FDB transcript so
//     downstream Gemini generations don't see stale wording.
func (s *Service) UpdateSegment(
	ctx context.Context,
	req *richterv1.UpdateTranscriptSegmentRequest,
) (*richterv1.UpdateTranscriptSegmentResponse, error) {
	lessonID, err := svc.ParseUUID(req.GetLessonId())
	if err != nil {
		return nil, err
	}
	if err := s.RequireTeacherRole(ctx, lessonID); err != nil {
		return nil, err
	}

	segs := segment.LoadSegments(s.KV, lessonID.String())
	if len(segs) == 0 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no segments found — run Step 2 first"))
	}

	idx := int(req.GetSegmentIndex())
	if idx < 0 || idx >= len(segs) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("segment_index %d out of range [0, %d)", idx, len(segs)))
	}

	segs[idx].Text = req.GetText()

	if err := segment.SaveSegments(s.KV, lessonID.String(), segs); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("save segments: %w", err))
	}

	// Rebuild transcript text so the chunk pipeline sees the edited content.
	var parts []string
	for _, sg := range segs {
		if sg.Text != "" {
			parts = append(parts, sg.Text)
		}
	}
	rebuilt := strings.Join(parts, " ")
	if err := segment.SaveTranscript(s.KV, lessonID.String(), rebuilt); err != nil {
		s.Log.WarnContext(ctx, "ai: failed to rebuild transcript after segment edit", "err", err)
	}

	// Rebuild each chunk's FDB transcript so it reflects the edited segments.
	if chunks, cerr := db.WithConnection(s.Postgres, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: s.LessonOpsLimit(), Offset: 0})
	}); cerr == nil {
		for _, c := range chunks {
			chunkText := segment.BuildChunkTranscript(segs, float32(c.StartSeconds), float32(c.EndSeconds))
			if chunkText != "" {
				if err := segment.SaveChunkTranscript(s.KV, c.ID.String(), chunkText); err != nil {
					s.Log.WarnContext(ctx, "ai: failed to rebuild chunk transcript after segment edit",
						"chunk_id", c.ID.String(), "err", err)
				}
			}
		}
	}

	out := segs[idx]
	return &richterv1.UpdateTranscriptSegmentResponse{
		Segment: &richterv1.TranscriptSegment{
			StartSeconds: out.StartSeconds,
			EndSeconds:   out.EndSeconds,
			Text:         out.Text,
		},
	}, nil
}
