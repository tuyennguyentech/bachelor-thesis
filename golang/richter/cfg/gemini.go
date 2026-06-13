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
}

func NewGeminiCfg() GeminiCfg {
	return GeminiCfg{
		Model:  "gemini-3.1-flash-lite",
		Engine: "gemini",
	}
}

func NewGeminiCfgSvc(i do.Injector) (*GeminiCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.GeminiCfg, nil
}
