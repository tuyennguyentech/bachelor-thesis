package ai

import (
	"context"
	"fmt"
	"strings"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/sql/gen"
	"github.com/google/generative-ai-go/genai"
)

// ── Step 3: UpdateTranscriptSegment ──────────────────────────────────────────

func (s *AISvc) UpdateTranscriptSegment(
	ctx context.Context,
	req *richterv1.UpdateTranscriptSegmentRequest,
) (*richterv1.UpdateTranscriptSegmentResponse, error) {
	return s.transcript.UpdateSegment(ctx, req)
}

// ── Step 5: Chunk editing ─────────────────────────────────────────────────────

func (s *AISvc) ListLessonTranscriptChunks(
	ctx context.Context,
	req *richterv1.ListLessonTranscriptChunksRequest,
) (*richterv1.ListLessonTranscriptChunksResponse, error) {
	return s.transcript.List(ctx, req)
}

func (s *AISvc) UpdateChunkConfig(
	ctx context.Context,
	req *richterv1.UpdateChunkConfigRequest,
) (*richterv1.UpdateChunkConfigResponse, error) {
	return s.transcript.UpdateConfig(ctx, req)
}

func (s *AISvc) MergeChunks(
	ctx context.Context,
	req *richterv1.MergeChunksRequest,
) (*richterv1.MergeChunksResponse, error) {
	mergedChunk, err := s.chunkOps.Merge(ctx, req)
	if err != nil {
		return nil, err
	}
	return &richterv1.MergeChunksResponse{MergedChunk: chunkToProto(mergedChunk)}, nil
}

func (s *AISvc) DeleteChunk(
	ctx context.Context,
	req *richterv1.DeleteChunkRequest,
) (*richterv1.DeleteChunkResponse, error) {
	if err := s.chunkOps.Delete(ctx, req); err != nil {
		return nil, err
	}
	return &richterv1.DeleteChunkResponse{}, nil
}

func (s *AISvc) SplitChunk(
	ctx context.Context,
	req *richterv1.SplitChunkRequest,
) (*richterv1.SplitChunkResponse, error) {
	result, err := s.chunkOps.Split(ctx, req)
	if err != nil {
		return nil, err
	}
	return &richterv1.SplitChunkResponse{
		FirstChunk:  chunkToProto(result.First),
		SecondChunk: chunkToProto(result.Second),
	}, nil
}

// ── Step 5d: AdjustChunkBoundary ─────────────────────────────────────────────

func (s *AISvc) AdjustChunkBoundary(
	ctx context.Context,
	req *richterv1.AdjustChunkBoundaryRequest,
) (*richterv1.AdjustChunkBoundaryResponse, error) {
	result, err := s.chunkOps.AdjustBoundary(ctx, req)
	if err != nil {
		return nil, err
	}
	return &richterv1.AdjustChunkBoundaryResponse{
		PrevChunk: chunkToProto(result.Prev),
		NextChunk: chunkToProto(result.Next),
	}, nil
}

// ── Gemini helpers ────────────────────────────────────────────────────────────

// extractStatusCode extracts an HTTP status code string from a Gemini error message.
// Returns "429", "503", etc. if found, otherwise "rate limit".
func extractStatusCode(msg string) string {
	for _, code := range []string{"503", "429", "500", "502", "504"} {
		if strings.Contains(msg, code) {
			return code
		}
	}
	return "rate limit"
}

// friendlyGeminiError maps verbose Gemini API errors to user-readable messages.
func friendlyGeminiError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	// Check for rate-limit / quota signals. "rate" alone is too broad (matches "generate").
	isRateLimit := strings.Contains(msg, "429") ||
		strings.Contains(msg, "quota") ||
		strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "ratelimit") ||
		strings.Contains(msg, "RATE_LIMIT_EXCEEDED") ||
		strings.Contains(msg, "RESOURCE_EXHAUSTED") ||
		strings.Contains(msg, "503") ||
		strings.Contains(msg, "overloaded")
	if isRateLimit {
		return fmt.Errorf("Vượt hạn mức Gemini API (%s). Vui lòng thử lại sau vài phút.", extractStatusCode(msg))
	}
	return err
}

// isTransientGeminiError reports whether a Gemini error is the kind that clears
// on a retry — rate-limit/quota (429), server overload (5xx), or an empty/
// truncated response under load. Mirrors the generation package's check so the
// chunk stage retries transient failures instead of failing the whole pipeline.
func isTransientGeminiError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, marker := range []string{
		"429", "quota", "rate limit", "ratelimit", "RESOURCE_EXHAUSTED",
		"503", "overloaded", "500", "502", "504", "UNAVAILABLE",
		"empty gemini response", "no candidates", "no content parts", "stopped unexpectedly",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func geminiResponseText(resp *genai.GenerateContentResponse) (string, error) {
	if len(resp.Candidates) == 0 {
		return "", fmt.Errorf("empty gemini response: no candidates")
	}
	cand := resp.Candidates[0]
	// MAX_TOKENS finish reason means the JSON was cut off mid-generation.
	if cand.FinishReason != 0 && cand.FinishReason != genai.FinishReasonStop {
		return "", fmt.Errorf("gemini stopped unexpectedly (finish_reason=%v) — try a shorter input or increase max_output_tokens", cand.FinishReason)
	}
	if cand.Content == nil || len(cand.Content.Parts) == 0 {
		return "", fmt.Errorf("empty gemini response: no content parts")
	}
	var b strings.Builder
	for _, p := range cand.Content.Parts {
		if txt, ok := p.(genai.Text); ok {
			b.WriteString(string(txt))
		}
	}
	raw := strings.TrimSpace(b.String())
	if raw == "" {
		return "", fmt.Errorf("empty gemini response: no text content")
	}
	// Strip markdown code fences that some models add even with ResponseMIMEType=application/json.
	if strings.HasPrefix(raw, "```") {
		// Remove opening fence: ```json or ```
		if after, found := strings.CutPrefix(raw, "```json"); found {
			raw = after
		} else {
			raw, _ = strings.CutPrefix(raw, "```")
		}
		// Remove closing fence: prefer \n``` (fence on its own line) to avoid
		// accidentally truncating JSON content that happens to contain backticks.
		if idx := strings.LastIndex(raw, "\n```"); idx != -1 {
			raw = raw[:idx]
		} else if idx := strings.LastIndex(raw, "```"); idx != -1 {
			raw = raw[:idx]
		}
		raw = strings.TrimSpace(raw)
	}
	return raw, nil
}

func normalizeGeneratedInteractionStartSeconds(ints []gen.LessonInteraction, chunks []gen.LessonTranscriptChunk) {
	if len(ints) == 0 || len(chunks) == 0 {
		return
	}
	chunkEndByID := make(map[string]float32, len(chunks))
	for _, chunk := range chunks {
		if chunk.EndSeconds > 0 {
			chunkEndByID[chunk.ID.String()] = float32(chunk.EndSeconds)
		}
	}
	for i := range ints {
		if ints[i].GeneratedBy != "ai" || ints[i].StartSeconds > 0 || !ints[i].ChunkID.Valid {
			continue
		}
		if endSeconds, ok := chunkEndByID[ints[i].ChunkID.String()]; ok {
			ints[i].StartSeconds = endSeconds
		}
	}
}

