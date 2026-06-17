package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/internal/svc/ai/genengine"
	"example.com/richter/log"
)

type chunkingService struct {
	aiCfg  *cfg.AiCfg
	engine genengine.Engine
	log    *log.LogSvc
}

func newChunkingService(aiCfg *cfg.AiCfg, engine genengine.Engine, logSvc *log.LogSvc) *chunkingService {
	return &chunkingService{aiCfg: aiCfg, engine: engine, log: logSvc}
}

// transcriptChunkRaw is the boundary-only Gemini response for a chunk.
// Transcript text is assembled programmatically from segments (no redundant Gemini output).
type transcriptChunkRaw struct {
	Summary      string  `json:"summary"`
	StartSeconds float32 `json:"start_seconds"`
	EndSeconds   float32 `json:"end_seconds"`
}

// aiCtx returns a child of ctx with the given timeout, or returns ctx
// unchanged when d is 0 (unlimited). Clamps negative values to 0.
func (s *chunkingService) aiCtx(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, d)
}

// runGeminiChunk calls Gemini with the transcript text (no video) to determine chunk boundaries.
func (s *chunkingService) runGeminiChunk(ctx context.Context, transcript string, segmentsJSON []byte) ([]transcriptChunkRaw, error) {
	ctx, cancel := s.aiCtx(ctx, s.aiCfg.ChunkingTimeout)
	defer cancel()

	var sb strings.Builder
	sb.WriteString(`Bạn là trợ lý giáo dục. Dựa trên nội dung phiên âm bài giảng và các mốc thời gian dưới đây, hãy phân chia bài giảng thành các đoạn lớn theo chủ đề/nội dung gắn kết (thường 3-7 đoạn).

Nội dung phiên âm:
`)
	sb.WriteString(transcript)

	if len(segmentsJSON) > 0 {
		sb.WriteString("\n\nCác mốc thời gian (JSON):\n")
		sb.Write(segmentsJSON)
	}

	sb.WriteString(`

Chỉ trả về ranh giới thời gian và tóm tắt — KHÔNG cần trả lại nội dung transcript (sẽ được lắp ráp từ mốc thời gian ở phía server).

Trả về JSON:
{
  "chunks": [
    {
      "summary": "Tóm tắt ngắn gọn (2-5 từ)",
      "start_seconds": 0.0,
      "end_seconds": 120.0
    }
  ]
}`)

	s.log.InfoContext(ctx, "[GENAI] ChunkTranscript: generating", "engine", s.engine.Name())

	// Retry transient Gemini failures (429 quota, 5xx, overloaded) with linear
	// backoff — the SAME policy item generation already uses. Running several
	// lesson pipelines at once can momentarily exhaust the free-tier per-minute
	// quota; without this a single transient 429 here kills the whole pipeline at
	// the chunk stage (observed as "Không thể phân đoạn").
	attempts := max(s.aiCfg.GeminiMaxAttempts, 1)
	var raw string
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		raw, err = s.engine.Generate(ctx, genengine.Request{
			Prompt:          sb.String(),
			Temperature:     0.2,
			MaxOutputTokens: 32768,
			JSONOutput:      true,
			Purpose:         genengine.PurposeChunk,
		})
		if err == nil {
			break
		}
		if !isTransientGeminiError(err) || attempt == attempts {
			return nil, friendlyGeminiError(err)
		}
		s.log.WarnContext(ctx, "[GENAI] ChunkTranscript: transient error, retrying",
			"attempt", attempt, "max", attempts, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * s.aiCfg.GeminiRetryBackoff):
		}
	}

	var result struct {
		Chunks []transcriptChunkRaw `json:"chunks"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("parse gemini response: %w", err)
	}

	for i := range result.Chunks {
		ch := &result.Chunks[i]
		if ch.EndSeconds <= ch.StartSeconds {
			ch.EndSeconds = ch.StartSeconds + 30
		}
		if ch.StartSeconds < 0 {
			ch.StartSeconds = 0
		}
	}
	// Sort by start_seconds so the saved order_index matches video timeline.
	// Gemini sometimes returns chunks out of order, especially with longer
	// transcripts. Without this, the editor displays the LLM's arrival order.
	sort.SliceStable(result.Chunks, func(i, j int) bool {
		return result.Chunks[i].StartSeconds < result.Chunks[j].StartSeconds
	})
	return result.Chunks, nil
}
