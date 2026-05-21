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

// GradeAudio sends the student's audio to Gemini and returns a structured grading result.
//
// Parameters:
//   - audioMP3: raw audio bytes of the student's recording (any container Gemini accepts)
//   - language: "vi" or "en", used to localise the grading prompt
//   - passageMarkdown: the passage the student was asked to read/answer
//   - question: non-empty only for OPEN_ANSWER mode
//   - expectedAnswer: gold answer for OPEN_ANSWER mode (empty for PRONUNCIATION mode)
func (s *AISvc) GradeAudio(ctx context.Context, audioMP3 []byte, language, passageMarkdown, question, expectedAnswer string) (*AudioGradingResult, error) {
	client, err := s.newGeminiClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("gemini audio grade: %w", err)
	}
	defer client.Close()

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.ResponseMIMEType = "application/json"

	// Build the grading schema
	schema := `{
  "type": "object",
  "required": ["transcript", "pronunciation_score", "feedback"],
  "properties": {
    "transcript":          {"type": "string"},
    "pronunciation_score": {"type": "number", "minimum": 0, "maximum": 1},
    "content_score":       {"type": "number", "minimum": 0, "maximum": 1},
    "feedback":            {"type": "string"}
  }
}`
	model.ResponseSchema = mustParseSchema(schema)

	prompt := buildAudioGradingPrompt(language, passageMarkdown, question, expectedAnswer)

	audioPart := genai.Blob{
		MIMEType: detectAudioMIME(audioMP3),
		Data:     audioMP3,
	}

	resp, err := model.GenerateContent(ctx, genai.Text(prompt), audioPart)
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
	result.PronunciationScore = clamp01(result.PronunciationScore)
	result.ContentScore = clamp01(result.ContentScore)
	return &result, nil
}

func buildAudioGradingPrompt(language, passageMarkdown, question, expectedAnswer string) string {
	var sb strings.Builder

	isOpenAnswer := strings.TrimSpace(question) != ""

	if language == "en" {
		if isOpenAnswer {
			sb.WriteString("You are an English language teacher. Grade this student's spoken answer.\n\n")
			sb.WriteString("Context passage:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nQuestion: ")
			sb.WriteString(question)
			if strings.TrimSpace(expectedAnswer) != "" {
				sb.WriteString("\n\nExpected answer (gold reference): ")
				sb.WriteString(expectedAnswer)
			}
			sb.WriteString("\n\nListen to the student's audio and:\n")
			sb.WriteString("1. Transcribe what the student said (transcript)\n")
			sb.WriteString("2. Rate pronunciation quality: 0.0 = very poor, 1.0 = excellent (pronunciation_score)\n")
			sb.WriteString("3. Rate content correctness against the expected answer if provided, otherwise against the passage: 0.0 = wrong/irrelevant, 1.0 = fully correct (content_score)\n")
			sb.WriteString("4. Write short, encouraging feedback in English (1-2 sentences) (feedback)\n")
		} else {
			sb.WriteString("You are an English language teacher. Grade this student's reading aloud exercise.\n\n")
			sb.WriteString("The student was asked to read this passage aloud:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nListen to the student's audio and:\n")
			sb.WriteString("1. Transcribe what the student said (transcript)\n")
			sb.WriteString("2. Rate pronunciation quality: 0.0 = very poor, 1.0 = excellent (pronunciation_score)\n")
			sb.WriteString("3. Set content_score to 0 (not applicable for reading aloud)\n")
			sb.WriteString("4. Write short, encouraging feedback in English (1-2 sentences) (feedback)\n")
		}
	} else {
		// Vietnamese
		if isOpenAnswer {
			sb.WriteString("Bạn là giáo viên tiếng Việt. Hãy chấm điểm câu trả lời nói của học sinh.\n\n")
			sb.WriteString("Đoạn văn ngữ cảnh:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nCâu hỏi: ")
			sb.WriteString(question)
			if strings.TrimSpace(expectedAnswer) != "" {
				sb.WriteString("\n\nĐáp án mẫu (tham chiếu): ")
				sb.WriteString(expectedAnswer)
			}
			sb.WriteString("\n\nNghe audio của học sinh và:\n")
			sb.WriteString("1. Chép lại những gì học sinh nói (transcript)\n")
			sb.WriteString("2. Đánh giá chất lượng phát âm: 0.0 = rất kém, 1.0 = xuất sắc (pronunciation_score)\n")
			sb.WriteString("3. Đánh giá mức độ đúng của nội dung so với đáp án mẫu (nếu có), nếu không thì so với đoạn văn: 0.0 = sai/không liên quan, 1.0 = hoàn toàn đúng (content_score)\n")
			sb.WriteString("4. Viết nhận xét ngắn gọn, khuyến khích bằng tiếng Việt (1-2 câu) (feedback)\n")
		} else {
			sb.WriteString("Bạn là giáo viên tiếng Việt. Hãy chấm điểm bài đọc to của học sinh.\n\n")
			sb.WriteString("Học sinh được yêu cầu đọc to đoạn văn sau:\n")
			sb.WriteString(passageMarkdown)
			sb.WriteString("\n\nNghe audio của học sinh và:\n")
			sb.WriteString("1. Chép lại những gì học sinh nói (transcript)\n")
			sb.WriteString("2. Đánh giá chất lượng phát âm: 0.0 = rất kém, 1.0 = xuất sắc (pronunciation_score)\n")
			sb.WriteString("3. Đặt content_score = 0 (không áp dụng cho bài đọc to)\n")
			sb.WriteString("4. Viết nhận xét ngắn gọn, khuyến khích bằng tiếng Việt (1-2 câu) (feedback)\n")
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

func mustParseSchema(raw string) *genai.Schema {
	var s genai.Schema
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		panic(fmt.Sprintf("mustParseSchema: %v", err))
	}
	return &s
}
