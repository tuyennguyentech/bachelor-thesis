package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

type TTSCfg struct {
	// Endpoint is the base URL of the VieNeu-TTS-v2 service.
	// Defaults to http://vieneu-tts:8200.
	Endpoint string `mapstructure:"endpoint"`
}

func NewTTSCfg() TTSCfg {
	return TTSCfg{Endpoint: "http://vieneu-tts:8200"}
}

func NewTTSCfgSvc(i do.Injector) (*TTSCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg: %w", err)
	}
	return &r.TTSCfg, nil
}
