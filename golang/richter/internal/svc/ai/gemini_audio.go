package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/google/generative-ai-go/genai"
)

// AudioGradingResult holds the AI grading output for a spoken response.
type AudioGradingResult struct {
	// Transcript is what the AI heard the student say.
	Transcript string `json:"transcript"`
	// PronunciationScore is 0.0–1.0.
	PronunciationScore float32 `json:"pronunciation_score"`
	// ContentScore is 0.0–1.0 (only set for OPEN_ANSWER mode).
	ContentScore float32 `json:"content_score,omitempty"`
	// Feedback is a short explanation for the student.
	Feedback string `json:"feedback"`
}

func (s *gradingService) GradeAudio(ctx context.Context, audioMP3 []byte, language, passageMarkdown, question, expectedAnswer string) (*AudioGradingResult, error) {
	// 1. Write the student audio bytes to a temp file so we can stream it
	// into the Whisper multipart request without holding a second copy in RAM.
	audioTmp, err := os.CreateTemp("", "richter-grade-audio-*")
	if err != nil {
		return nil, fmt.Errorf("gemini audio grade: create temp audio file: %w", err)
	}
	audioTmpPath := audioTmp.Name()
	defer os.Remove(audioTmpPath)
	if _, err := audioTmp.Write(audioMP3); err != nil {
		audioTmp.Close()
		return nil, fmt.Errorf("gemini audio grade: write temp audio file: %w", err)
	}
	audioTmp.Close()

	// 2. Call Whisper to transcribe the audio.
	transcript, _, werr := s.transcription.whisperTranscribe(ctx, audioTmpPath)
	if werr != nil {
		return nil, fmt.Errorf("gemini audio grade: whisper transcription: %w", werr)
	}

	if strings.TrimSpace(transcript) == "" || isWhisperHallucination(transcript, language) {
		return &AudioGradingResult{
			Transcript:         "",
			PronunciationScore: 0.0,
			ContentScore:       0.0,
			Feedback:           "Không phát hiện thấy tiếng nói hoặc âm thanh không rõ ràng. Vui lòng ghi âm lại.",
		}, nil
	}

	client, err := newGeminiClient(ctx, s.geminiCfg)
	if err != nil {
		return nil, fmt.Errorf("gemini audio grade: %w", err)
	}
	defer client.Close()

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.ResponseMIMEType = "application/json"

	// Build the response schema with the SDK's typed struct.
	model.ResponseSchema = audioGradingResponseSchema()

	prompt := buildTextGradingPrompt(language, passageMarkdown, question, expectedAnswer, transcript)

	resp, err := model.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		return nil, fmt.Errorf("gemini audio grade: generate: %w", err)
	}
	raw, err := geminiResponseText(resp)
	if err != nil {
		return nil, fmt.Errorf("gemini audio grade: response text: %w", err)
	}

	var result AudioGradingResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("gemini audio grade: parse response: %w", err)
	}
	result.Transcript = transcript
	result.PronunciationScore = clamp01(result.PronunciationScore)
	result.ContentScore = clamp01(result.ContentScore)
	return &result, nil
}

func buildTextGradingPrompt(language, passageMarkdown, question, expectedAnswer, transcript string) string {
	var sb strings.Builder

	isOpenAnswer := strings.TrimSpace(question) != ""

	if language == "en" {
		if isOpenAnswer {
			sb.WriteString("You are a professional language assessor. Grade this student's spoken response based on the transcription of their audio recording.\n\n")
			sb.WriteString("Context passage:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nQuestion asked: ")
			sb.WriteString(question)
			if strings.TrimSpace(expectedAnswer) != "" {
				sb.WriteString("\n\nReference answer (not the only correct phrasing): ")
				sb.WriteString(expectedAnswer)
			}
			sb.WriteString("\n\nStudent's transcribed answer: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nScoring rubric:\n")
			sb.WriteString("pronunciation_score [0.0–1.0]: Assess delivery clarity and fluency from the transcription quality. 1.0 = coherent, natural-sounding transcript that matches expected English; 0.5 = partially intelligible with noticeable gaps; 0.0 = transcript is incoherent or completely off-topic.\n")
			sb.WriteString("content_score [0.0–1.0]: Assess whether the student's answer addresses the question correctly based on MEANING, not exact words. 1.0 = captures the core concept correctly, possibly with different phrasing or synonyms; 0.5–0.8 = partially correct or missing one key point; 0.0 = wrong or irrelevant. If no reference answer is provided, grade against the passage content.\n")
			sb.WriteString("feedback: 1–2 sentences in English. Be specific and encouraging: confirm what was right, or name exactly what concept was missed (do not just say 'wrong').\n")
		} else {
			sb.WriteString("You are a professional language assessor. Grade this student's read-aloud exercise based on the transcription of their audio recording.\n\n")
			sb.WriteString("Target passage the student was asked to read:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nStudent's transcribed reading: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nScoring rubric:\n")
			sb.WriteString("pronunciation_score [0.0–1.0]: Compare the transcription against the target passage word-by-word. 1.0 = transcript closely matches the passage (minor articles/conjunctions may differ); deduct proportionally for missing content words, substituted key terms, or completely skipped sentences. 0.0 = transcript bears no resemblance to the passage.\n")
			sb.WriteString("content_score: set to 0 (not applicable for read-aloud).\n")
			sb.WriteString("feedback: 1–2 sentences in English. Highlight specific words or phrases that were read well or that differed from the passage; be encouraging.\n")
		}
	} else {
		// Vietnamese
		if isOpenAnswer {
			sb.WriteString("Bạn là giám khảo ngôn ngữ chuyên nghiệp. Chấm điểm câu trả lời nói của học sinh dựa trên bản ghi phiên âm từ giọng nói.\n\n")
			sb.WriteString("Đoạn văn ngữ cảnh:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nCâu hỏi: ")
			sb.WriteString(question)
			if strings.TrimSpace(expectedAnswer) != "" {
				sb.WriteString("\n\nĐáp án tham chiếu (không phải cách diễn đạt duy nhất đúng): ")
				sb.WriteString(expectedAnswer)
			}
			sb.WriteString("\n\nBản ghi phiên âm câu trả lời của học sinh: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nRubric chấm điểm:\n")
			sb.WriteString("pronunciation_score [0.0–1.0]: Đánh giá độ rõ ràng và mạch lạc của phần nói dựa trên chất lượng phiên âm. 1.0 = phiên âm mạch lạc, tự nhiên, phù hợp tiếng Việt chuẩn; 0.5 = hiểu được nhưng có khoảng trống hoặc câu chưa hoàn chỉnh; 0.0 = phiên âm không rõ nghĩa.\n")
			sb.WriteString("content_score [0.0–1.0]: Đánh giá mức độ trả lời ĐÚNG VỀ NGỮ NGHĨA — không yêu cầu trùng từng chữ với đáp án tham chiếu. 1.0 = nắm đúng khái niệm cốt lõi, dù diễn đạt khác; 0.5–0.8 = đúng một phần hoặc thiếu một điểm quan trọng; 0.0 = sai hoàn toàn hoặc không liên quan. Nếu không có đáp án tham chiếu, chấm dựa trên nội dung đoạn văn.\n")
			sb.WriteString("feedback: 1–2 câu tiếng Việt, KHUYẾN KHÍCH và CỤ THỂ: xác nhận điểm đúng hoặc chỉ rõ khái niệm nào còn thiếu/sai (không chỉ nói 'chưa đúng').\n")
		} else {
			sb.WriteString("Bạn là giám khảo ngôn ngữ chuyên nghiệp. Chấm điểm bài đọc to của học sinh dựa trên bản ghi phiên âm từ giọng nói.\n\n")
			sb.WriteString("Đoạn văn học sinh được yêu cầu đọc to:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nBản ghi phiên âm bài đọc của học sinh: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nRubric chấm điểm:\n")
			sb.WriteString("pronunciation_score [0.0–1.0]: So sánh phiên âm với đoạn văn gốc theo từng từ nội dung. 1.0 = phiên âm khớp chặt với đoạn văn (có thể bỏ sót mạo từ/liên từ nhỏ); trừ điểm tỷ lệ cho từ nội dung bị thiếu, bị đọc sai, hoặc câu bị bỏ qua hoàn toàn. 0.0 = phiên âm không giống đoạn văn.\n")
			sb.WriteString("content_score: đặt = 0 (không áp dụng cho bài đọc to).\n")
			sb.WriteString("feedback: 1–2 câu tiếng Việt, KHUYẾN KHÍCH. Nêu cụ thể từ/câu được đọc tốt hoặc cần cải thiện; không chỉ nhận xét chung chung.\n")
		}
	}
	return sb.String()
}

// detectAudioMIME returns the appropriate MIME type for audio bytes based on magic bytes.
// Falls back to "audio/webm" which is the default format from browser MediaRecorder.
func detectAudioMIME(b []byte) string {
	if len(b) >= 4 {
		// EBML header → WebM/MKV container
		if b[0] == 0x1a && b[1] == 0x45 && b[2] == 0xdf && b[3] == 0xa3 {
			return "audio/webm"
		}
		// OGG
		if b[0] == 'O' && b[1] == 'g' && b[2] == 'g' && b[3] == 'S' {
			return "audio/ogg"
		}
		// WAV
		if b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' {
			return "audio/wav"
		}
		// ID3 tag (MP3 with metadata)
		if b[0] == 'I' && b[1] == 'D' && b[2] == '3' {
			return "audio/mpeg"
		}
		// MP3 sync frame
		if b[0] == 0xff && (b[1]&0xe0) == 0xe0 {
			return "audio/mpeg"
		}
	}
	return "audio/webm"
}

func clamp01(v float32) float32 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// audioGradingResponseSchema describes the JSON shape Gemini must return for
// reading audio grading. Built with the SDK's typed Schema struct so we can't
// hit the JSON-unmarshal panic that previously killed every grading request.
// Note: genai.Schema doesn't expose `minimum`/`maximum`; we clamp the values
// to [0,1] in Go after parsing the response instead.
func audioGradingResponseSchema() *genai.Schema {
	return &genai.Schema{
		Type:     genai.TypeObject,
		Required: []string{"transcript", "pronunciation_score", "feedback"},
		Properties: map[string]*genai.Schema{
			"transcript":          {Type: genai.TypeString},
			"pronunciation_score": {Type: genai.TypeNumber},
			"content_score":       {Type: genai.TypeNumber},
			"feedback":            {Type: genai.TypeString},
		},
	}
}

func isWhisperHallucination(transcript string, language string) bool {
	t := strings.ToLower(strings.TrimSpace(transcript))

	// Globally remove any punctuation/special characters and collapse spaces
	var sb strings.Builder
	for _, r := range t {
		if r == '.' || r == ',' || r == '!' || r == '?' || r == '"' || r == '\'' || r == '-' || r == ';' || r == ':' || r == '_' || r == '(' || r == ')' {
			continue
		}
		sb.WriteRune(r)
	}
	cleaned := strings.Join(strings.Fields(sb.String()), " ")

	// Common hallucinations list (fully stripped of punctuation and collapsed)
	hallucinations := map[string]bool{
		"thank you":              true,
		"thank you thank you":    true,
		"thank you so much":      true,
		"thank you very much":    true,
		"thanks":                 true,
		"thanks for watching":    true,
		"thank you for watching": true,
		"you":                    true,
		"go":                     true,
		"bye":                    true,
		"bye bye":                true,
		"oh":                     true,
		"yeah":                   true,
		"yes":                    true,
		"no":                     true,
		"uh":                     true,
		"um":                     true,
		"shh":                    true,
		"hãy đăng ký kênh":       true,
		"cảm ơn các bạn đã xem":  true,
		"cảm ơn":                 true,
		"cảm ơn bạn":             true,
		"cám ơn":                 true,
		"谢谢":                     true,
		"谢谢大家":                   true,
		"谢谢大家观看":                 true,
		"谢谢观看":                   true,
	}

	if hallucinations[cleaned] {
		return true
	}

	// If language is English or Vietnamese and transcript contains CJK (Chinese, Japanese, Korean) characters, it's a hallucination
	if language == "en" || language == "vi" {
		cjkCount := 0
		for _, r := range t {
			if (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0x3040 && r <= 0x30FF) || (r >= 0x31F0 && r <= 0x31FF) || (r >= 0x1100 && r <= 0x11FF) || (r >= 0xAC00 && r <= 0xD7AF) {
				cjkCount++
			}
		}
		if cjkCount > 0 {
			return true
		}
	}

	return false
}
