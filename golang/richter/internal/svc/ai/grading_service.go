package ai

import "example.com/richter/cfg"

type gradingService struct {
	geminiCfg     *cfg.GeminiCfg
	transcription *transcriptionService
}

func newGradingService(geminiCfg *cfg.GeminiCfg, transcription *transcriptionService) *gradingService {
	return &gradingService{geminiCfg: geminiCfg, transcription: transcription}
}
