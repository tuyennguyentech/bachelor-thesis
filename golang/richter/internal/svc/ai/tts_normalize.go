package ai

import (
	"regexp"
	"strings"
)

// normalizeForTTS rewrites math / CS notation into speakable words before the
// text is handed to the phoneme TTS (Piper). A neural phoneme voice fed raw
// notation — "O(n²)", "Θ(n log n)", "T(n) = aT(n/b)", "7 % 2", Greek letters,
// superscripts — produces clipped, garbled "ô tri" audio. This is the #1 cause
// of unintelligible listening exercises on technical courses (e.g. DSA, where
// transcripts are saturated with complexity notation).
//
// The listening prompt also instructs Gemini to spell notation out in words, so
// this runs as a deterministic safety net for whatever notation slips through.
// It is language-aware ("vi" default, "en" for English audio) and intentionally
// errs toward pronounceability over perfect semantics — audible-but-slightly-off
// beats unintelligible noise.
func normalizeForTTS(text, language string) string {
	en := language == "en"

	// 1. Big-O / Big-Theta / Big-Omega function notation → words. Run BEFORE the
	//    Greek/symbol replacer so the leading symbol is still attached to its
	//    parentheses (e.g. "Θ(n log n)" → "theta của n log n").
	text = bigORe.ReplaceAllStringFunc(text, func(m string) string {
		sub := bigORe.FindStringSubmatch(m)
		if sub == nil {
			return m
		}
		inner := strings.TrimSpace(sub[2])
		var name string
		switch strings.ToUpper(sub[1]) {
		case "Θ":
			name = "theta"
		case "Ω":
			name = "omega"
		default: // O / o
			if en {
				name = "Big O"
			} else {
				name = "O lớn"
			}
		}
		if en {
			return " " + name + " of " + inner + " "
		}
		return " " + name + " của " + inner + " "
	})

	// 2. Superscripts → words ("n²" → "n bình phương" / "n squared").
	text = superscriptRe.ReplaceAllStringFunc(text, func(run string) string {
		return superscriptWords(run, en)
	})

	// 3. Bulk symbol → words (Greek letters, comparison/math operators).
	text = symbolReplacer(en).Replace(text)

	// 4. Strip leftover unspeakable clutter (brackets, underscores, etc.).
	text = leftoverSymbolRe.ReplaceAllString(text, " ")

	// 5. Collapse the whitespace the substitutions introduced.
	text = multiSpaceRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

var (
	// bigORe matches "X(expr)" where X is an UPPERCASE O / Θ / Ω immediately
	// followed by "(" — asymptotic-complexity notation that must be read as words.
	// Requiring uppercase + no space before "(" avoids false-matching ordinary
	// prose like "vào (xem hình)" (lowercase o + space). The inner expression is
	// bounded so a stray "(" can't swallow a whole sentence.
	bigORe = regexp.MustCompile(`([OΘΩ])\(\s*([^()]{1,48}?)\s*\)`)
	// superscriptRe matches a run of Unicode superscript characters.
	superscriptRe = regexp.MustCompile(`[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ]+`)
	// leftoverSymbolRe drops bracket/clutter characters that carry no spoken
	// meaning once the math has been verbalised. Operators that DO carry meaning
	// (=, /, %, <, >, +, ^, *, _) are handled by symbolReplacer instead.
	leftoverSymbolRe = regexp.MustCompile("[()\\[\\]{}|\\\\~`#@]")
	// multiSpaceRe collapses runs of spaces/tabs created by the replacements.
	multiSpaceRe = regexp.MustCompile(`[ \t]{2,}`)
)

// superscriptWords renders a run of superscript characters as spoken words.
func superscriptWords(run string, en bool) string {
	var b strings.Builder
	for _, r := range run {
		switch r {
		case '²':
			if en {
				b.WriteString(" squared")
			} else {
				b.WriteString(" bình phương")
			}
		case '³':
			if en {
				b.WriteString(" cubed")
			} else {
				b.WriteString(" lập phương")
			}
		case 'ⁿ':
			if en {
				b.WriteString(" to the n")
			} else {
				b.WriteString(" mũ n")
			}
		default:
			if d := superscriptDigit(r); d != "" {
				if en {
					b.WriteString(" to the power ")
				} else {
					b.WriteString(" mũ ")
				}
				b.WriteString(d)
			}
		}
	}
	return b.String()
}

// superscriptDigit maps a superscript digit rune to its ASCII digit, or "".
func superscriptDigit(r rune) string {
	switch r {
	case '⁰':
		return "0"
	case '¹':
		return "1"
	case '⁴':
		return "4"
	case '⁵':
		return "5"
	case '⁶':
		return "6"
	case '⁷':
		return "7"
	case '⁸':
		return "8"
	case '⁹':
		return "9"
	}
	return ""
}

// symbolReplacer builds the language-aware Greek-letter + operator replacer.
// strings.Replacer applies all substitutions in a single left-to-right pass
// (longest match wins), so there is no cascading re-replacement.
func symbolReplacer(en bool) *strings.Replacer {
	pick := func(enWord, viWord string) string {
		if en {
			return enWord
		}
		return viWord
	}
	pairs := []string{
		// Greek letters (spoken the same regardless of surrounding language).
		"Θ", "theta", "θ", "theta",
		"Ω", "omega", "ω", "omega",
		"Σ", " sigma ", "∑", " sigma ",
		"Π", "pi", "π", "pi",
		"Δ", "delta", "δ", "delta",
		"λ", "lambda", "α", "alpha", "β", "beta", "γ", "gamma",
		"μ", "mu", "µ", "mu", "Φ", "phi", "φ", "phi",
		// Unicode math symbols + ASCII operators (language-aware wording).
		"√", pick(" square root of ", " căn "),
		"∞", pick(" infinity ", " vô cùng "),
		"≤", pick(" less than or equal to ", " nhỏ hơn hoặc bằng "),
		"≥", pick(" greater than or equal to ", " lớn hơn hoặc bằng "),
		"≠", pick(" not equal to ", " khác "),
		"≈", pick(" approximately ", " xấp xỉ "),
		"≡", pick(" equals ", " bằng "),
		"→", pick(" leads to ", " dẫn đến "),
		"⇒", pick(" implies ", " suy ra "),
		"∈", pick(" in ", " thuộc "),
		"×", pick(" times ", " nhân "),
		"·", pick(" times ", " nhân "),
		"÷", pick(" divided by ", " chia "),
		"±", pick(" plus or minus ", " cộng trừ "),
		// Math-only operators kept (rare in prose, common in notation that slips
		// through): "=", "^", "*", "%". ASCII "/", "+", "<", ">", "&" are NOT
		// rewritten — they false-positive on dates ("20/6"), URLs, "C++", "R&D",
		// and Piper voices them acceptably as-is, whereas the prompt already asks
		// the model to spell genuine math out in words.
		"=", pick(" equals ", " bằng "),
		"^", pick(" to the power ", " mũ "),
		"*", pick(" times ", " nhân "),
		"%", pick(" percent ", " phần trăm "),
		"_", " ",
	}
	return strings.NewReplacer(pairs...)
}
