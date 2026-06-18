package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type GeminiCfg struct {
	APIKey string `mapstructure:"api_key"`
	Model  string `mapstructure:"model"`
	// Engine selects the LLM backend behind the generation abstraction:
	// "gemini" (default) calls the real Gemini API; "mock" uses an in-process
	// engine that returns canned, schema-valid responses (no network, no quota)
	// for the test suite. Set engine = "mock" in richter.test.toml.
	Engine string `mapstructure:"engine"`
	// MaxConcurrent caps in-flight Gemini generate calls across the WHOLE
	// process (every pipeline, every chunk). Free-tier Gemini has a low
	// per-minute quota; without a cap, several quick-create pipelines fire many
	// concurrent calls, collectively blow the quota, and each one 429s into a
	// retry-storm that stalls generation for tens of minutes. Mirrors
	// STTMaxConcurrent. 0 = unlimited. Default 2 keeps free-tier usage smooth.
	MaxConcurrent int `mapstructure:"max_concurrent"`
}

func NewGeminiCfg() GeminiCfg {
	return GeminiCfg{
		Model:         "gemini-3.1-flash-lite",
		Engine:        "gemini",
		MaxConcurrent: 2,
	}
}

func NewGeminiCfgSvc(i do.Injector) (*GeminiCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.GeminiCfg, nil
}
