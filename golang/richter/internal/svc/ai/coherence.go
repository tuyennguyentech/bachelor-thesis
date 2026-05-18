package ai

import (
	"regexp"
	"strings"
)

// coherenceStopwords filters out high-frequency function words that would
// otherwise inflate the "core vocabulary" of every chunk. Mirrors the VI+EN
// list used previously on the frontend.
var coherenceStopwords = func() map[string]struct{} {
	words := []string{
		// Vietnamese function words
		"là", "của", "và", "có", "được", "cho", "để", "trong", "với", "này",
		"đó", "đây", "như", "khi", "nếu", "mà", "nhưng", "hoặc", "vì", "nên",
		"đã", "đang", "sẽ", "không", "phải", "chỉ", "cũng", "rất", "lại", "thì",
		"về", "ở", "từ", "bằng", "theo", "qua", "trên", "dưới", "sau", "trước",
		"tôi", "bạn", "nó", "họ", "chúng", "ta", "mình", "ai", "gì", "nào",
		"sao", "đâu", "một", "hai", "ba", "các", "những", "mỗi", "nhiều", "ít",
		"thế", "ra", "vào", "lên", "xuống", "đi", "đến", "tới", "nữa", "thêm",
		"rồi", "vẫn", "còn", "hay", "chứ", "à", "nhé", "đấy", "ấy", "luôn",
		// English function words
		"the", "is", "are", "was", "were", "be", "been", "being",
		"to", "of", "in", "on", "at", "by", "for", "with", "from",
		"and", "or", "but", "if", "then", "as", "that", "this", "these", "those",
		"it", "its", "he", "she", "they", "we", "you", "me", "my", "our", "your",
		"do", "does", "did", "not", "no", "so", "such", "very", "more", "most",
		"all", "any", "some", "can", "will", "would", "should", "could", "may",
		"has", "have", "had", "an", "there", "here", "what", "which", "who",
	}
	out := make(map[string]struct{}, len(words))
	for _, w := range words {
		out[w] = struct{}{}
	}
	return out
}()

var coherenceTokenRe = regexp.MustCompile(`\p{L}{2,}`)

// tokenizeForCoherence returns the set of distinct stopword-free content
// tokens in text (lowercased, length ≥ 2 letters, Unicode \p{L}).
func tokenizeForCoherence(text string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, m := range coherenceTokenRe.FindAllString(strings.ToLower(text), -1) {
		if _, stop := coherenceStopwords[m]; stop {
			continue
		}
		out[m] = struct{}{}
	}
	return out
}

// computeChunkCoherence returns the per-segment core-vocabulary coverage
// score in [0, 1] for the segments contained in one chunk.
//
// For each segment, we count how many of its content words also appear in
// at least one OTHER segment of the same chunk ("core vocabulary"), then
// divide by that segment's content-word count. The chunk's score is the
// mean of these per-segment ratios.
//
// Intuition: a chunk that stays on one topic has a small recurring core
// vocabulary that shows up in most segments — high coverage. A chunk that
// jumps between topics has each segment contributing one-off vocabulary —
// low coverage.
func computeChunkCoherence(segs []transcriptSegment) float32 {
	if len(segs) == 0 {
		return 0
	}
	if len(segs) == 1 {
		return 1
	}
	tokens := make([]map[string]struct{}, len(segs))
	for i, s := range segs {
		tokens[i] = tokenizeForCoherence(s.Text)
	}
	docFreq := map[string]int{}
	for _, set := range tokens {
		for w := range set {
			docFreq[w]++
		}
	}
	if len(docFreq) == 0 {
		return 0
	}
	core := map[string]struct{}{}
	for w, c := range docFreq {
		if c >= 2 {
			core[w] = struct{}{}
		}
	}
	var covSum float64
	var covN int
	for _, s := range tokens {
		if len(s) == 0 {
			continue
		}
		inCore := 0
		for w := range s {
			if _, ok := core[w]; ok {
				inCore++
			}
		}
		covSum += float64(inCore) / float64(len(s))
		covN++
	}
	if covN == 0 {
		return 0
	}
	return float32(covSum / float64(covN))
}

// chunkSegments filters all transcript segments down to those whose
// start_seconds falls inside [start, end). Half-open matches buildChunkTranscript.
func chunkSegments(segs []transcriptSegment, start, end float32) []transcriptSegment {
	out := make([]transcriptSegment, 0)
	for _, s := range segs {
		if s.StartSeconds >= start && s.StartSeconds < end {
			out = append(out, s)
		}
	}
	return out
}
