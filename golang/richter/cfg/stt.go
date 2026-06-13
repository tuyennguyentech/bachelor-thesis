package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type STTCfg struct {
	// Endpoint is host:port of the faster-whisper-server (speaches) instance.
	// When empty, ExtractTranscriptStream falls back to Gemini video upload.
	Endpoint string `mapstructure:"endpoint"`
	Model    string `mapstructure:"model"`
}

func NewSTTCfg() STTCfg {
	return STTCfg{Model: "Systran/faster-whisper-small"}
}

func NewSTTCfgSvc(i do.Injector) (*STTCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg: %w", err)
	}
	return &r.STTCfg, nil
}
