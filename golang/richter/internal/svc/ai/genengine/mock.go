package genengine

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// MockLatency is the delay the mock engine waits before returning. Real Gemini
// generation takes ~1–2s; the async task UI (running → done transitions, the
// "ready to generate" surface) and the E2E flow were built around that. A
// zero-latency mock collapses those transitions and breaks the workflow, so the
// mock deliberately simulates a small, realistic latency. It is a var so unit
// tests that only check response shape can set it to 0.
var MockLatency = 1500 * time.Millisecond

// mockEngine returns deterministic, schema-valid canned responses instead of
// calling Gemini. It lets the test suite run the full chunking + item-generation
// pipeline with zero network calls and zero quota, and makes content-asserting
// tests deterministic (every interaction kind is always present and valid).
type mockEngine struct{}

// NewMock returns the in-process mock engine.
func NewMock() Engine { return &mockEngine{} }

func (m *mockEngine) Name() string { return "mock" }

func (m *mockEngine) Generate(ctx context.Context, req Request) (string, error) {
	// Simulate realistic generation latency (cancellable).
	if MockLatency > 0 {
		select {
		case <-time.After(MockLatency):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}

	if resp, ok := mockResponses[req.Purpose]; ok {
		return resp, nil
	}
	// Any unrecognised item purpose falls back to the AI-choose response (one of
	// every kind), so a new kind still yields a parseable item under the mock.
	if strings.HasPrefix(string(req.Purpose), "items") {
		return mockResponses[PurposeItemsAIChoose], nil
	}
	return "", fmt.Errorf("mock engine: no canned response for purpose %q", req.Purpose)
}

// mockResponses holds one schema-valid canned response per purpose. The item
// shapes must match the generators' GeminiSchema/ParseGeminiItem in
// internal/svc/interactions (mcq.go, fill_blank.go, reading.go, listening.go).
var mockResponses = map[Purpose]string{
	PurposeChunk: `{"chunks":[{"summary":"Đoạn mẫu (mock)","start_seconds":0,"end_seconds":7}]}`,

	ItemsPurpose("mcq"):             `{"items":[` + mockSingleChoice + `]}`,
	ItemsPurpose("multiple_choice"): `{"items":[` + mockMultipleChoice + `]}`,
	ItemsPurpose("fill_blank"):      `{"items":[` + mockFillBlank + `]}`,
	ItemsPurpose("reading"):         `{"items":[` + mockReading + `]}`,
	ItemsPurpose("listening"):       `{"items":[` + mockListening + `]}`,

	// AI-choose: one item of every supported kind, so content-asserting tests
	// that expect all kinds pass deterministically.
	PurposeItemsAIChoose: `{"items":[` +
		mockSingleChoice + `,` + mockMultipleChoice + `,` + mockFillBlank + `,` +
		mockReading + `,` + mockListening + `]}`,
}

// Each item carries a "kind" field. The per-kind generators ignore it (they
// don't DisallowUnknownFields), but the AI_CHOOSE path REQUIRES it to route each
// item to its handler — without it, AI_CHOOSE (the default strategy) silently
// drops every mock item.
const (
	mockSingleChoice = `{
		"kind": "mcq",
		"question_text": "Mock: 2 + 2 bằng mấy?",
		"options": ["3", "4", "5"],
		"correct_answer": 1,
		"explanation": "Đáp án mẫu cho kiểm thử tự động.",
		"start_seconds": 1.0
	}`

	mockMultipleChoice = `{
		"kind": "multiple_choice",
		"question_text": "Mock: chọn các số chẵn.",
		"options": ["1", "2", "3", "4"],
		"correct_answers": [1, 3],
		"explanation": "Đáp án mẫu cho kiểm thử tự động.",
		"start_seconds": 1.5
	}`

	mockFillBlank = `{
		"kind": "fill_blank",
		"prompt": "Mock: điền vào chỗ trống.",
		"explanation": "Đáp án mẫu cho kiểm thử tự động.",
		"start_seconds": 2.0,
		"config": {
			"template": "Một thuật toán gồm {{0}} và {{1}}.",
			"blanks": [
				{"accepted": ["đầu vào", "input"], "case_sensitive": false, "hint": "2 từ"},
				{"accepted": ["đầu ra", "output"], "case_sensitive": false, "hint": "2 từ"}
			]
		}
	}`

	mockReading = `{
		"kind": "reading",
		"prompt": "Mock: đọc đoạn văn và trả lời.",
		"explanation": "Đáp án mẫu cho kiểm thử tự động.",
		"start_seconds": 2.5,
		"mode": "open_answer",
		"passage_markdown": "Đây là đoạn văn mẫu dùng cho kiểm thử tự động của tính năng đọc hiểu.",
		"question": "Đoạn văn này dùng để làm gì?",
		"expected_answer": "Kiểm thử tự động."
	}`

	// audio_source_text is deliberately >= 40 words and there are >= 2 questions
	// so the mock satisfies the listening validation floor (minListeningWords +
	// the schema's minItems:2). A shorter passage would be rejected by
	// ParseGeminiItem and break content-asserting tests under engine=mock.
	mockListening = `{
		"kind": "listening",
		"prompt": "Mock: nghe đoạn giảng và trả lời.",
		"explanation": "Đáp án mẫu cho kiểm thử tự động.",
		"start_seconds": 3.0,
		"audio_source_text": "Đây là một đoạn giảng mẫu khá đầy đủ dùng cho kiểm thử tự động của tính năng nghe hiểu. Đoạn này trình bày một ý tưởng hoàn chỉnh với độ dài hợp lý để hệ thống tổng hợp giọng nói tạo ra tệp âm thanh có ý nghĩa. Nội dung mô tả cách một thuật toán xử lý dữ liệu đầu vào, thực hiện các bước tính toán trung gian, rồi trả về kết quả đầu ra cuối cùng cho người dùng.",
		"questions": [
			{
				"question": "Đoạn giảng mẫu này chủ yếu mô tả điều gì?",
				"options": ["Cách một thuật toán xử lý dữ liệu", "Luật bóng đá", "Dự báo thời tiết", "Công thức nấu ăn"],
				"correct_answer": 0
			},
			{
				"question": "Bước cuối cùng được nhắc đến trong đoạn là gì?",
				"options": ["Trả về kết quả đầu ra", "Xoá dữ liệu", "Khởi động lại máy", "Gửi email"],
				"correct_answer": 0
			}
		]
	}`
)
