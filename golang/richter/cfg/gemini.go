package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type GeminiCfg struct {
	APIKey string `mapstructure:"api_key"`
	Model  string `mapstructure:"model"`
}

func NewGeminiCfg() GeminiCfg {
	return GeminiCfg{
		Model: "gemini-3.1-flash-lite",
	}
}

func NewGeminiCfgSvc(i do.Injector) (*GeminiCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg cannot be invoked: %w", err)
	}
	return &r.GeminiCfg, nil
}
