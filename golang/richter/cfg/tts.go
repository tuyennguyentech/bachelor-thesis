package cfg

import (
	"fmt"

	"github.com/samber/do/v2"
)

// TTSCfg configures the text-to-speech provider. TTS is served by the Speaches
// service (the same service used for STT) via its OpenAI-compatible
// /v1/audio/speech endpoint, so each language maps to a Piper model + voice.
type TTSCfg struct {
	// Endpoint is the base URL of the Speaches service. Defaults to
	// http://speaches:8000.
	Endpoint string `mapstructure:"endpoint"`
	// ViModel/ViVoice are the model id and voice used for Vietnamese.
	ViModel string `mapstructure:"vi_model"`
	ViVoice string `mapstructure:"vi_voice"`
	// EnModel/EnVoice are the model id and voice used for English.
	EnModel string `mapstructure:"en_model"`
	EnVoice string `mapstructure:"en_voice"`
}

func NewTTSCfg() TTSCfg {
	return TTSCfg{
		Endpoint: "http://speaches:8000",
		ViModel:  "speaches-ai/piper-vi_VN-vais1000-medium",
		ViVoice:  "vais1000",
		EnModel:  "speaches-ai/piper-en_US-lessac-medium",
		EnVoice:  "lessac",
	}
}

func NewTTSCfgSvc(i do.Injector) (*TTSCfg, error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		return nil, fmt.Errorf("RichterCfg: %w", err)
	}
	return &r.TTSCfg, nil
}
