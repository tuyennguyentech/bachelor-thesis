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
	// Language is the SPOKEN language of the source audio (ISO-639-1, e.g. "vi",
	// "en") sent to Whisper as a transcription hint. This is deliberately distinct
	// from the lesson's OUTPUT language (lesson.language, which controls the
	// language of generated questions/exercises): a teacher may study a Vietnamese
	// video but want English exercises. Empty = let Whisper auto-detect (default);
	// auto-detect is unreliable on short/accented clips and can mis-detect a
	// Vietnamese clip as English, so set this to the audio language when known.
	Language string `mapstructure:"language"`
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
