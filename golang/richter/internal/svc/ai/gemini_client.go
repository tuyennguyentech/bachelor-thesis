package ai

import (
	"context"
	"fmt"

	"example.com/richter/cfg"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

func newGeminiClient(ctx context.Context, cfg *cfg.GeminiCfg) (*genai.Client, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("Gemini API key not configured (set RICHTER_GEMINI_API_KEY or gemini.api_key in config)")
	}
	c, err := genai.NewClient(ctx, option.WithAPIKey(cfg.APIKey))
	if err != nil {
		return nil, fmt.Errorf("create gemini client: %w", err)
	}
	return c, nil
}
