package transcript

import (
	"strings"
	"testing"
)

func TestIsDegenerateTranscript(t *testing.T) {
	// The actual repetition-loop from the incident: "Kết hợp phép tính" repeated.
	loop := strings.TrimSpace(strings.Repeat("Kết hợp phép tính ", 78))
	// A single word repeated (degenerate single-token loop).
	singleWordLoop := strings.TrimSpace(strings.Repeat("cảm_ơn ", 60))
	// A real, varied transcript (the correct output for the same audio, VAD on).
	real := "Kết hợp phép tính. Chịp làm gì mà lén lút thế? Em đang chồng cây. " +
		"Chịp chồng cây không điểm chứ gì? Chịp định giấu mẹ bài kiểm tra này đúng không? " +
		"Khi tính toán các phép tính cộng, ta thực hiện lần lượt từ trái sang phải. " +
		"Chịp thử làm lại bài xem nào, cộng trước rồi mới trừ, nhớ đặt tính thẳng hàng."

	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"repetition loop", loop, true},
		{"single-word loop", singleWordLoop, true},
		{"real varied transcript", real, false},
		{"empty", "", false},
		{"short clip below floor", "Xin chào các em, hôm nay chúng ta học về phép cộng.", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDegenerateTranscript(tc.in); got != tc.want {
				t.Fatalf("IsDegenerateTranscript(%q...) = %v, want %v", firstN(tc.in, 40), got, tc.want)
			}
		})
	}
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
