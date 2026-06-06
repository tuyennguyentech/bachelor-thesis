package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"example.com/richter/cfg"
	"example.com/richter/log"
	"github.com/google/generative-ai-go/genai"
)

type chunkingService struct {
	geminiCfg *cfg.GeminiCfg
	log       *log.LogSvc
}

func newChunkingService(geminiCfg *cfg.GeminiCfg, logSvc *log.LogSvc) *chunkingService {
	return &chunkingService{geminiCfg: geminiCfg, log: logSvc}
}

// transcriptChunkRaw is the boundary-only Gemini response for a chunk.
// Transcript text is assembled programmatically from segments (no redundant Gemini output).
type transcriptChunkRaw struct {
	Summary      string  `json:"summary"`
	StartSeconds float32 `json:"start_seconds"`
	EndSeconds   float32 `json:"end_seconds"`
}

// runGeminiChunk calls Gemini with the transcript text (no video) to determine chunk boundaries.
func (s *chunkingService) runGeminiChunk(ctx context.Context, transcript string, segmentsJSON []byte) ([]transcriptChunkRaw, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	client, err := newGeminiClient(ctx, s.geminiCfg)
	if err != nil {
		return nil, err
	}
	defer client.Close()

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.SetTemperature(0.2)
	model.ResponseMIMEType = "application/json"
	model.SetMaxOutputTokens(32768)

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

	s.log.InfoContext(ctx, "[GEMINI] ChunkTranscript: calling GenerateContent")
	resp, err := model.GenerateContent(ctx, genai.Text(sb.String()))
	if err != nil {
		return nil, friendlyGeminiError(fmt.Errorf("generate content: %w", err))
	}

	raw, err := geminiResponseText(resp)
	if err != nil {
		return nil, err
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
