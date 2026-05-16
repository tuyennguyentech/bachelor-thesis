package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type WhisperCfg struct {
	// Endpoint is host:port of the faster-whisper-server (speaches) instance.
	// When empty, ExtractTranscriptStream falls back to Gemini video upload.
	Endpoint string `mapstructure:"endpoint"`
	Model    string `mapstructure:"model"`
}

func NewWhisperCfg() WhisperCfg {
	return WhisperCfg{Model: "Systran/faster-whisper-small"}
}

func NewWhisperCfgSvc(i do.Injector) (*WhisperCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg: %w", err)
	}
	return &r.WhisperCfg, nil
}
