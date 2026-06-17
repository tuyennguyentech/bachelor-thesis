package ai

import (
	"strings"
	"testing"
)

func TestBuildTextOnlyGradingPrompt(t *testing.T) {
	t.Parallel()
	t.Run("Vietnamese prompt", func(t *testing.T) {
		prompt := buildTextOnlyGradingPrompt("vi", "Điền từ vào câu", "học sinh", "học sinh, học viên")
		if !strings.Contains(prompt, "Tiếng Việt") {
			t.Errorf("expected prompt to contain Tiếng Việt, got %s", prompt)
		}
		if !strings.Contains(prompt, "học sinh") || !strings.Contains(prompt, "học sinh, học viên") {
			t.Errorf("expected prompt to contain bối cảnh/đáp án/câu trả lời")
		}
	})

	t.Run("English prompt", func(t *testing.T) {
		prompt := buildTextOnlyGradingPrompt("en", "Complete blank", "student", "student, pupil")
		if !strings.Contains(prompt, "Tiếng Anh (English)") {
			t.Errorf("expected prompt to contain Tiếng Anh (English), got %s", prompt)
		}
	})
}
