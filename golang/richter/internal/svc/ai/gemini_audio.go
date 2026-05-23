package ai

import (
	"context"
	"encoding/json"
	"fmt"
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

func (s *AISvc) GradeAudio(ctx context.Context, audioMP3 []byte, language, passageMarkdown, question, expectedAnswer string) (*AudioGradingResult, error) {
	// 1. Call Whisper to transcribe the audio.
	transcript, _, werr := s.whisperTranscribe(ctx, audioMP3)
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

	client, err := s.newGeminiClient(ctx)
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
			sb.WriteString("You are an English language teacher. Grade this student's spoken answer based on the provided transcription of their audio.\n\n")
			sb.WriteString("Context passage:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nQuestion: ")
			sb.WriteString(question)
			if strings.TrimSpace(expectedAnswer) != "" {
				sb.WriteString("\n\nExpected answer (gold reference): ")
				sb.WriteString(expectedAnswer)
			}
			sb.WriteString("\n\nStudent's transcribed answer: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nEvaluate the student's response:\n")
			sb.WriteString("1. Rate pronunciation/clarity quality: 0.0 = very poor/unclear, 1.0 = excellent/clear (pronunciation_score). Note: since you are reading a transcript, base this on how coherent and clear the transcription is compared to natural spoken English.\n")
			sb.WriteString("2. Rate content correctness against the expected answer if provided, otherwise against the passage: 0.0 = wrong/irrelevant, 1.0 = fully correct (content_score)\n")
			sb.WriteString("3. Write short, encouraging feedback in English (1-2 sentences) (feedback)\n")
		} else {
			sb.WriteString("You are an English language teacher. Grade this student's reading aloud exercise based on the provided transcription of their audio.\n\n")
			sb.WriteString("The student was asked to read this passage aloud:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nStudent's transcribed reading: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nEvaluate the student's reading:\n")
			sb.WriteString("1. Rate pronunciation/accuracy quality: 0.0 = very poor/does not match the passage, 1.0 = excellent/matches the passage perfectly (pronunciation_score). Base this on how well the transcription matches the target passage (missing words, extra words, or replaced words should lower the score).\n")
			sb.WriteString("2. Set content_score to 0 (not applicable for reading aloud)\n")
			sb.WriteString("3. Write short, encouraging feedback in English (1-2 sentences) (feedback)\n")
		}
	} else {
		// Vietnamese
		if isOpenAnswer {
			sb.WriteString("Bạn là giáo viên tiếng Việt. Hãy chấm điểm câu trả lời nói của học sinh dựa trên bản ghi phiên âm từ giọng nói của học sinh.\n\n")
			sb.WriteString("Đoạn văn ngữ cảnh:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nCâu hỏi: ")
			sb.WriteString(question)
			if strings.TrimSpace(expectedAnswer) != "" {
				sb.WriteString("\n\nĐáp án mẫu (tham chiếu): ")
				sb.WriteString(expectedAnswer)
			}
			sb.WriteString("\n\nBản ghi phiên âm câu trả lời của học sinh: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nĐánh giá câu trả lời của học sinh:\n")
			sb.WriteString("1. Đánh giá chất lượng phát âm/độ rõ ràng: 0.0 = rất kém/không rõ ràng, 1.0 = xuất sắc/rõ ràng (pronunciation_score). Chấm điểm dựa trên độ mạch lạc và chuẩn xác của văn bản phiên âm.\n")
			sb.WriteString("2. Đánh giá mức độ đúng của nội dung so với đáp án mẫu (nếu có), nếu không thì so với đoạn văn: 0.0 = sai/không liên quan, 1.0 = hoàn toàn đúng (content_score)\n")
			sb.WriteString("3. Viết nhận xét ngắn gọn, khuyến khích bằng tiếng Việt (1-2 câu) (feedback)\n")
		} else {
			sb.WriteString("Bạn là giáo viên tiếng Việt. Hãy chấm điểm bài đọc to của học sinh dựa trên bản ghi phiên âm từ giọng nói của học sinh.\n\n")
			sb.WriteString("Học sinh được yêu cầu đọc to đoạn văn sau:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nBản ghi phiên âm bài đọc của học sinh: ")
			sb.WriteString(transcript)
			sb.WriteString("\n\nĐánh giá bài đọc của học sinh:\n")
			sb.WriteString("1. Đánh giá chất lượng phát âm/độ chính xác: 0.0 = rất kém/không khớp với đoạn văn, 1.0 = xuất sắc/khớp hoàn toàn với đoạn văn (pronunciation_score). Điểm số dựa trên việc so sánh bản ghi phiên âm với đoạn văn mẫu (các từ bị thiếu, từ thừa hoặc từ bị đọc sai khiến phiên âm khác đi sẽ làm giảm điểm).\n")
			sb.WriteString("2. Đặt content_score = 0 (không áp dụng cho bài đọc to)\n")
			sb.WriteString("3. Viết nhận xét ngắn gọn, khuyến khích bằng tiếng Việt (1-2 câu) (feedback)\n")
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
		"thank you": true,
		"thank you thank you": true,
		"thank you so much": true,
		"thank you very much": true,
		"thanks": true,
		"thanks for watching": true,
		"thank you for watching": true,
		"you": true,
		"go": true,
		"bye": true,
		"bye bye": true,
		"oh": true,
		"yeah": true,
		"yes": true,
		"no": true,
		"uh": true,
		"um": true,
		"shh": true,
		"hãy đăng ký kênh": true,
		"cảm ơn các bạn đã xem": true,
		"cảm ơn": true,
		"cảm ơn bạn": true,
		"cám ơn": true,
		"谢谢": true,
		"谢谢大家": true,
		"谢谢大家观看": true,
		"谢谢观看": true,
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
