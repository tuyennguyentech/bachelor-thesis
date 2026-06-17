package svc

import "testing"

// TestEffectiveProgressStep guards the pipeline step-display fix: inside a
// composite pipeline_run the sub-services must report the COARSE stage so the
// FE's 3-stage strip advances correctly. The regression it prevents: the chunk
// stage emits ANALYSIS_PROGRESS_STEP_ANALYZING — the SAME enum the transcribe
// stage emits — so a FE keyed on the raw step can't tell which stage it is and
// gets stuck on stage 1. With a stage label set, the coarse label wins.
func TestEffectiveProgressStep(t *testing.T) {
	cases := []struct {
		name     string
		detailed string
		label    string
		want     string
	}{
		{"manual flow keeps detailed step", "ANALYSIS_PROGRESS_STEP_ANALYZING", "", "ANALYSIS_PROGRESS_STEP_ANALYZING"},
		{"pipeline chunk reports CHUNKING (the bug case)", "ANALYSIS_PROGRESS_STEP_ANALYZING", "CHUNKING", "CHUNKING"},
		{"pipeline transcribe reports TRANSCRIBING", "ANALYSIS_PROGRESS_STEP_DOWNLOADING", "TRANSCRIBING", "TRANSCRIBING"},
		{"pipeline gen reports GENERATING", "GENERATE_INTERACTIONS_STEP_CHUNK", "GENERATING", "GENERATING"},
		{"manual gen keeps detailed step", "GENERATE_INTERACTIONS_STEP_CHUNK", "", "GENERATE_INTERACTIONS_STEP_CHUNK"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := effectiveProgressStep(tc.detailed, tc.label); got != tc.want {
				t.Errorf("effectiveProgressStep(%q, %q) = %q, want %q", tc.detailed, tc.label, got, tc.want)
			}
		})
	}
}
