package ai

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/generative-ai-go/genai"
)

// TextGradingResult holds the AI grading output for a textual response.
type TextGradingResult struct {
	Score    float32 `json:"score"`
	Feedback string  `json:"feedback"`
}

// GradeText grades a textual response (like fill-blank, dictation, short answer)
// using Gemini Pro, supporting semantic matching and synomyms.
func (s *AISvc) GradeText(ctx context.Context, language, question, studentAnswer, expectedAnswer string) (float32, string, error) {
	client, err := s.newGeminiClient(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("gemini text grade: %w", err)
	}
	defer client.Close()

	model := client.GenerativeModel(s.geminiCfg.Model)
	model.ResponseMIMEType = "application/json"
	model.ResponseSchema = &genai.Schema{
		Type:     genai.TypeObject,
		Required: []string{"score", "feedback"},
		Properties: map[string]*genai.Schema{
			"score": {
				Type:        genai.TypeNumber,
				Description: "Điểm số trong khoảng từ 0.0 đến 1.0. 1.0 nghĩa là hoàn toàn đúng hoặc diễn đạt đồng nghĩa hoàn hảo. 0.0 nghĩa là hoàn toàn sai hoặc không liên quan.",
			},
			"feedback": {
				Type:        genai.TypeString,
				Description: "Nhận xét ngắn gọn, khích lệ giải thích tại sao câu trả lời đúng hoặc chỉ ra lỗi sai nhỏ của học sinh.",
			},
		},
	}

	prompt := buildTextOnlyGradingPrompt(language, question, studentAnswer, expectedAnswer)

	resp, err := model.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		return 0, "", fmt.Errorf("gemini text grade: generate: %w", err)
	}
	raw, err := geminiResponseText(resp)
	if err != nil {
		return 0, "", fmt.Errorf("gemini text grade: response text: %w", err)
	}

	var result TextGradingResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return 0, "", fmt.Errorf("gemini text grade: parse json: %w", err)
	}

	if result.Score < 0 {
		result.Score = 0
	} else if result.Score > 1.0 {
		result.Score = 1.0
	}

	return result.Score, result.Feedback, nil
}

func buildTextOnlyGradingPrompt(language, question, studentAnswer, expectedAnswer string) string {
	langName := "Tiếng Việt"
	if language == "en" {
		langName = "Tiếng Anh (English)"
	}

	return fmt.Sprintf(`Bạn là một giám khảo giáo dục chuyên nghiệp. Nhiệm vụ của bạn là đánh giá câu trả lời của học sinh so với đáp án mong đợi dưới đây.

Ngôn ngữ của bài học: %s

[BỐI CẢNH/CÂU HỎI]:
%s

[ĐÁP ÁN ĐÚNG/ĐÁP ÁN MONG ĐỢI]:
%s

[CÂU TRẢ LỜI CỦA HỌC SINH]:
%s

YÊU CẦU CHẤM ĐIỂM:
1. Đánh giá tính chính xác về mặt NGỮ NGHĨA.
2. Nếu câu trả lời của học sinh diễn đạt hoàn toàn trùng khớp hoặc là một từ/cụm từ đồng nghĩa hoàn hảo, mang ý nghĩa tương đương và phù hợp tuyệt đối với ngữ cảnh câu hỏi, hãy chấm 1.0 điểm.
3. Cho phép bỏ qua các lỗi nhỏ về dấu câu, lỗi viết hoa/viết thường, hoặc khoảng trắng dư thừa.
4. Đối với bài tập điền từ (fill-blank) hoặc bài tập nghe chính tả: Hãy cực kỳ linh hoạt với từ đồng nghĩa (ví dụ: "chạy" và "vận hành", "computer" và "máy tính", "bố" và "ba"). Nếu học sinh điền từ có nghĩa tương đương, hãy cho điểm tối đa (1.0).
5. Trả về điểm số trong khoảng [0.0, 1.0] và phản hồi nhận xét (feedback) ngắn gọn, súc tích bằng ngôn ngữ: %s.

Hãy trả về JSON khớp với schema yêu cầu.`, langName, question, expectedAnswer, studentAnswer, langName)
}
