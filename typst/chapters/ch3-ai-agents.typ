// ─── chapters/ch3-ai-agents.typ ──────────────────────────────────────────────
// Phần 3: Công cụ tác nhân AI (Agent Tools)

#import "../helpers.typ": hl, badge, tbl

= Công cụ tác nhân AI (Agent Tools)

Chương trước đã mô tả workflow tổng quát theo góc nhìn nghiệp vụ. Chương này đi vào chi tiết kỹ thuật: mỗi bước trong workflow được thực thi bởi tác nhân AI (agent) nào, sử dụng công nghệ gì, và hoạt động ra sao.

Hệ thống được thiết kế dựa trên kiến trúc *đa tác nhân* (Multi-Agent). Mỗi tác nhân đảm nhận một nhiệm vụ chuyên biệt: thu thập video, tạo phụ đề, soạn câu hỏi, chấm điểm và phân tích kết quả học tập. Hệ thống không tự huấn luyện mô hình AI mà tận dụng các API của mô hình ngôn ngữ lớn (LLM) kết hợp với các thuật toán tĩnh (rule-based).

== Công nghệ sử dụng

#tbl(
  (1fr, 2fr, 4fr),
  ("Agent", "Công nghệ", "Ghi chú"),
  (
    [Agent 1], [`yt-dlp` (mã nguồn mở, Python)], [Tải video + siêu dữ liệu + phụ đề từ YouTube và 1000+ nền tảng],
    [Agent 2], [Gemini API (Speech-to-Text)], [Hỗ trợ tiếng Việt tốt, miễn phí qua Google AI Studio cho sinh viên],
    [Agent 3], [Gemini API (text generation)], [Sinh câu hỏi từ transcript; hỗ trợ structured output (JSON)],
    [Agent 4], [Rule-based + Gemini API], [Trắc nghiệm: so sánh trực tiếp; câu hỏi mở: LLM đánh giá ngữ nghĩa],
    [Agent 5], [Thuật toán tĩnh (SQL)], [Tính toán heatmap, engagement score — không cần LLM],
  )
)

== Agent 1: Thu thập Video (Ingestion Agent)

*Mục tiêu:* Nhận đường dẫn URL video (YouTube, Vimeo, TED...) hoặc tệp tải lên từ máy tính, tải về máy chủ bao gồm tệp video, siêu dữ liệu (tiêu đề, mô tả) và phụ đề nếu có sẵn.

*Quy trình:*

+ Người dùng nhập URL hoặc tải tệp video lên hệ thống.
+ Hệ thống tải siêu dữ liệu và tệp video (giới hạn 720p để tối ưu lưu trữ).
+ Kiểm tra video có kèm phụ đề sẵn không. Nếu có phụ đề chất lượng tốt, lưu lại và bỏ qua Agent 2.
+ Lưu tệp vào hệ thống lưu trữ, ghi bản ghi vào cơ sở dữ liệu.
+ Đẩy công việc vào hàng đợi để Agent 2 xử lý bất đồng bộ.

== Agent 2: Xử lý Văn bản (Transcript Agent)

*Mục tiêu:* Chuyển đổi âm thanh trong video thành văn bản (transcript) có gắn mốc thời gian từng câu, phục vụ cho việc đồng bộ phụ đề với video và làm ngữ cảnh cho AI sinh câu hỏi.

*Quy trình:*

+ Bóc tách âm thanh từ tệp video.
+ Gửi âm thanh qua mô hình nhận diện giọng nói (Speech-to-Text) để chuyển thành văn bản kèm mốc thời gian.
+ Hậu xử lý: gộp các câu thoại quá ngắn (dưới 2 giây) thành khối câu hoàn chỉnh; phân tách đoạn dựa trên các khoảng lặng dài hơn 3 giây.
+ Chuyển đổi kết quả sang cấu trúc JSON để làm đầu vào cho Agent 3.

== Agent 3: Tạo Câu hỏi (Question Generation Agent)

Đây là tác nhân trung tâm của nền tảng. Agent nhận các khối văn bản (chunks) từ video, kết hợp với cấu hình sư phạm của giảng viên, rồi gửi yêu cầu tới LLM để sinh câu hỏi tương tác. Trong giai đoạn MVP, hệ thống hỗ trợ 3 loại: trắc nghiệm, đúng/sai và câu hỏi mở. Các loại nâng cao (lập trình, phát âm, nghe hiểu, luyện nói, điền từ) được trình bày chi tiết ở Phần 4.

=== Chiến lược thiết kế câu lệnh (Prompt engineering)

*Câu lệnh hệ thống (System prompt)* định nghĩa: vai trò chuyên gia, lĩnh vực, cấp độ theo thang Bloom (Ghi nhớ → Hiểu → Vận dụng), và ngôn ngữ đầu ra.

*Câu lệnh người dùng (User prompt)* bao gồm:
- Phân đoạn văn bản (đoạn 1–2 phút vừa xem)
- Siêu dữ liệu: môn học, cấp độ, loại câu hỏi yêu cầu
- Ràng buộc: "Câu hỏi PHẢI có thể trả lời hoàn toàn dựa trên văn bản này, không yêu cầu kiến thức ngoài"

*Cấu trúc đầu ra (Output schema):*
```json
{
  "question": "...",
  "type": "multiple_choice",
  "options": ["A", "B", "C", "D"],
  "correct_answer": "B",
  "explanation": "Theo transcript đoạn 3:24–4:10, ...",
  "timestamp_start": 204,
  "difficulty": "medium",
  "bloom_level": "understand"
}
```

*Kiểm tra chất lượng:* Hệ thống tính độ tương đồng ngữ nghĩa (cosine similarity) giữa câu hỏi vừa sinh ra và đoạn văn bản gốc. Nếu điểm tương đồng quá thấp (< 0.6), câu hỏi bị loại và yêu cầu LLM sinh lại — nhằm tránh hiện tượng "ảo giác" đã nêu ở Phần 1.

== Agent 4: Đánh giá Câu trả lời (Answer Evaluation Agent)

#tbl(
  (1fr, 3fr, 2fr),
  ("Loại câu trả lời", "Cách đánh giá", "Kết quả trả về"),
  (
    [Trắc nghiệm / Đúng-Sai], [So sánh trực tiếp với đáp án đúng (rule-based).], [Đúng/sai + lời giải thích trích từ transcript],
    [Câu hỏi mở], [LLM so sánh câu trả lời với đáp án mẫu và ngữ cảnh transcript.], [Điểm 0–1 + phản hồi có dẫn chứng],
  )
)

== Agent 5: Phân tích Học tập (Learning Analytics Agent)

Agent tổng hợp dữ liệu tương tác và kết quả kiểm tra để đưa ra các chỉ số phân tích:

- *Bản đồ nhiệt (Heatmap):* Trung bình điểm theo từng phân đoạn 30 giây của video — giúp nhận biết nhanh đoạn nào lớp học yếu.
- *Phát hiện lỗ hổng:* Phân đoạn có điểm trung bình < 60% sẽ được đánh dấu và đề xuất người học xem lại.
- *Điểm tương tác:* Kết hợp thời gian xem, tỷ lệ trả lời câu hỏi, và điểm số trung bình thành một chỉ số duy nhất.
- *Cảnh báo sớm:* Học viên có điểm tương tác < 40% trong 2 bài liên tiếp sẽ được gắn cờ cảnh báo cho giảng viên.

== Ánh xạ Agent — Workflow

#tbl(
  (1.5cm, 3cm, 1fr),
  ("Agent", "Workflow", "Vai trò"),
  (
    [1], [Flow 1 — Bước 1.2], [Tải video và siêu dữ liệu từ URL hoặc tệp tải lên],
    [2], [Flow 1 — Bước 1.2, 1.3], [Chuyển âm thanh thành transcript → phân đoạn nội dung],
    [3], [Flow 1 — Bước 1.4], [Sinh câu hỏi tương tác từ transcript theo cấu hình giảng viên],
    [4], [Flow 2 — Bước 2.3], [Đánh giá câu trả lời và phản hồi tức thì],
    [5], [Flow 3 — Bước 3.1], [Tổng hợp dữ liệu, tính heatmap, engagement score, cảnh báo],
  )
)