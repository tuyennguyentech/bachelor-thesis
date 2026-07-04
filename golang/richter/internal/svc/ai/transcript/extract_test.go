package transcript

import (
	"fmt"
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

	// Regression (lesson "Phân cụm với K-means"): a REAL 100-minute lecture
	// measured 14,322 tokens with only 1,236 distinct — global ratio 0.086,
	// which the old global `< 0.15` check misread as a loop (Heaps' law: the
	// distinct-token ratio of natural speech falls with length). Synthesize an
	// equivalent shape deterministically: 12,000 tokens over a 1,200-word
	// vocabulary (global ratio 0.10), locally varied so no window is loop-like.
	longVocab := make([]string, 1200)
	for i := range longVocab {
		longVocab[i] = fmt.Sprintf("từ%04d", i)
	}
	var longNatural strings.Builder
	for i := range 12000 {
		// Quadratic stride cycles the vocabulary non-repetitively, so every
		// 120-token window still sees ~100 distinct tokens (like real speech).
		longNatural.WriteString(longVocab[(i*i+i)%len(longVocab)])
		longNatural.WriteByte(' ')
	}
	// The same long lecture with a brief LOCAL Whisper stumble (a ~400-token
	// phrase loop, as observed in the real transcript) must still be usable.
	longWithLocalLoop := longNatural.String() + strings.Repeat("học không giám sát và cái bài toán ", 50)
	// A long transcript that is MOSTLY loop stays degenerate.
	longMostlyLoop := strings.TrimSpace(strings.Repeat("tất cả ", 6000))

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
		{"long natural lecture (Heaps-law ratio below 0.15)", longNatural.String(), false},
		{"long lecture with brief local loop", longWithLocalLoop, false},
		{"long mostly-loop transcript", longMostlyLoop, true},
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
