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
func (s *gradingService) GradeText(ctx context.Context, language, question, studentAnswer, expectedAnswer string) (float32, string, error) {
	client, err := newGeminiClient(ctx, s.geminiCfg)
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

	return fmt.Sprintf(`Bạn là giám khảo giáo dục chuyên nghiệp. Chấm điểm câu trả lời của học sinh theo NGHĨA — không phải so khớp từng chữ.

Ngôn ngữ bài học: %s

[BỐI CẢNH / CÂU HỎI]:
%s

[ĐÁP ÁN THAM CHIẾU]:
%s

[CÂU TRẢ LỜI CỦA HỌC SINH]:
%s

RUBRIC CHẤM ĐIỂM [0.0 – 1.0]:
- 1.0 = Hoàn toàn đúng về nghĩa: câu trả lời nắm được khái niệm cốt lõi, dù diễn đạt khác từ ngữ, dùng từ đồng nghĩa, viết tắt chấp nhận được, hoặc có lỗi chính tả / hoa thường nhỏ không ảnh hưởng nghĩa.
- 0.7–0.9 = Đúng một phần: hiểu đúng ý chính nhưng thiếu một chi tiết quan trọng, hoặc diễn đạt mơ hồ, hoặc dùng thuật ngữ gần đúng.
- 0.3–0.6 = Có liên quan nhưng sai đáng kể: nhận ra chủ đề nhưng hiểu sai khái niệm, hoặc trả lời một phần rất nhỏ.
- 0.0–0.2 = Sai hoàn toàn hoặc không liên quan: hiểu nhầm hoàn toàn, câu trả lời ngoài chủ đề, hoặc để trống.

QUY TẮC:
- Chú trọng NGỮ NGHĨA, không phải cú pháp hay từ ngữ cụ thể.
- Với fill-blank / dictation: chấp nhận từ đồng nghĩa chuẩn (ví dụ: "bubble sort" ↔ "sắp xếp nổi bọt", "O(n)" ↔ "tuyến tính"), viết hoa/thường không quan trọng.
- Không trừ điểm vì lỗi chính tả nhỏ hoặc thiếu dấu câu.
- feedback: 1–2 câu ngắn gọn, KHUYẾN KHÍCH, bằng %s. Nếu đúng: xác nhận và củng cố. Nếu sai/thiếu: chỉ ra cụ thể điểm nào cần cải thiện (không chỉ nói "sai").

Trả về JSON theo schema yêu cầu.`, langName, question, expectedAnswer, studentAnswer, langName)
}
