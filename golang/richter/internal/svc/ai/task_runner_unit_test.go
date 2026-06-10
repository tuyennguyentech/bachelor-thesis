package ai

import (
	"errors"
	"testing"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
)

// TestAnalysisStepCurrent_MapsAllSteps verifies the ordinal mapping every
// AnalysisProgressStep the runner uses maps to a 1..4 counter.
func TestAnalysisStepCurrent_MapsAllSteps(t *testing.T) {
	cases := []struct {
		step richterv1.AnalysisProgressStep
		want int32
	}{
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DOWNLOADING, 1},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UPLOADING, 2},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, 3},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING, 4},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UNSPECIFIED, 0},
	}
	for _, tc := range cases {
		if got := analysisStepCurrent(tc.step); got != tc.want {
			t.Errorf("analysisStepCurrent(%v) = %d, want %d", tc.step, got, tc.want)
		}
	}
}

// TestChunkStepCurrent_CollapsesToAnalyzingSaving verifies the chunk
// pipeline only ever reports two distinct progress points: 1=analyzing,
// 2=saving. Everything else falls back to analysisStepCurrent.
func TestChunkStepCurrent_CollapsesToAnalyzingSaving(t *testing.T) {
	cases := []struct {
		step richterv1.AnalysisProgressStep
		want int32
	}{
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_ANALYZING, 1},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_SAVING, 2},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DOWNLOADING, 1},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UPLOADING, 2},
		{richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_UNSPECIFIED, 0},
	}
	for _, tc := range cases {
		if got := chunkStepCurrent(tc.step); got != tc.want {
			t.Errorf("chunkStepCurrent(%v) = %d, want %d", tc.step, got, tc.want)
		}
	}
}

// TestIsTerminal covers the small switch used by the task store + worker to
// decide whether to short-circuit Cancel / completion.
func TestIsTerminal(t *testing.T) {
	cases := []struct {
		s    richterv1.LessonTaskStatus
		want bool
	}{
		{richterv1.LessonTaskStatus_LESSON_TASK_STATUS_QUEUED, false},
		{richterv1.LessonTaskStatus_LESSON_TASK_STATUS_RUNNING, false},
		{richterv1.LessonTaskStatus_LESSON_TASK_STATUS_SUCCEEDED, true},
		{richterv1.LessonTaskStatus_LESSON_TASK_STATUS_FAILED, true},
		{richterv1.LessonTaskStatus_LESSON_TASK_STATUS_CANCELED, true},
		{richterv1.LessonTaskStatus_LESSON_TASK_STATUS_UNSPECIFIED, false},
	}
	for _, tc := range cases {
		if got := isTerminal(tc.s); got != tc.want {
			t.Errorf("isTerminal(%v) = %v, want %v", tc.s, got, tc.want)
		}
	}
}

// TestFormatDuration_RendersHumanShort verifies the small "45s" /
// "1m30s" formatter used in the Whisper heartbeat message. Negative
// input must render as "0s" so the user never sees "-1s" flicker.
func TestFormatDuration_RendersHumanShort(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{-1 * time.Second, "0s"},
		{0, "0s"},
		{1 * time.Second, "1s"},
		{45 * time.Second, "45s"},
		{59 * time.Second, "59s"},
		{60 * time.Second, "1m0s"},
		{90 * time.Second, "1m30s"},
		{125 * time.Second, "2m5s"},
	}
	for _, tc := range cases {
		if got := formatDuration(tc.in); got != tc.want {
			t.Errorf("formatDuration(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// fakeTimeoutErr implements net.Error and reports Timeout()=true so we
// can verify isTimeoutErr unwraps it.
type fakeTimeoutErr struct{}

func (fakeTimeoutErr) Error() string   { return "i/o timeout" }
func (fakeTimeoutErr) Timeout() bool   { return true }
func (fakeTimeoutErr) Temporary() bool { return true }

// TestIsTimeoutErr_RecognisesNetError verifies the classifier used to
// produce the Vietnamese "máy chủ phiên âm không phản hồi" message
// fires on net.Error timeouts and skips non-timeout errors. nil must
// always return false.
func TestIsTimeoutErr_RecognisesNetError(t *testing.T) {
	if isTimeoutErr(nil) {
		t.Error("isTimeoutErr(nil) = true, want false")
	}
	if isTimeoutErr(errors.New("plain error")) {
		t.Error("isTimeoutErr(plain) = true, want false")
	}
	if !isTimeoutErr(fakeTimeoutErr{}) {
		t.Error("isTimeoutErr(net.Timeout) = false, want true")
	}
	// Also assert netErr can be unwrapped from a wrapped chain.
	wrapped := netErrWrap{fakeTimeoutErr{}}
	if !isTimeoutErr(wrapped) {
		t.Error("isTimeoutErr(wrapped net.Error) = false, want true (errors.As must unwrap)")
	}
}

type netErrWrap struct{ inner error }

func (w netErrWrap) Error() string { return "wrap: " + w.inner.Error() }
func (w netErrWrap) Unwrap() error { return w.inner }
