// ─── chapters/ch2-workflow.typ ────────────────────────────────────────────────
// Phần 2: Workflow tổng quát của hệ thống

#import "../helpers.typ": hl, tbl

= Workflow tổng quát của giải pháp

Dựa trên mô hình học tập đã xây dựng ở Phần 1, hệ thống hoạt động theo 3 luồng công việc nối tiếp: xây dựng lộ trình → thực hiện học tập → phân tích tiến trình.

== Flow 1 — Xây dựng lộ trình học tập

Luồng này diễn ra *trước khi người học bắt đầu*, do giảng viên hoặc người tự học khởi tạo.

+ *Xác định mục tiêu học tập:* Giảng viên khai báo tiêu đề, môn học, đối tượng, ngôn ngữ, và cấp độ nhận thức mong muốn (theo thang Bloom: Ghi nhớ → Hiểu → Vận dụng).

+ *Đưa tư liệu vào hệ thống:* Tải video bài giảng (MP4, URL YouTube...), tài liệu bổ trợ (PDF, slide), hoặc phụ đề có sẵn. Hệ thống tự động xử lý: tải video → bóc tách âm thanh → chuyển thành transcript có mốc thời gian.

+ *Phân đoạn nội dung:* Hệ thống chia video thành các phân đoạn 5–10 phút tại các mốc chuyển tiếp tự nhiên. Mỗi phân đoạn gắn với một khối transcript — đây là đơn vị cơ bản để sinh câu hỏi.

+ *Sinh các dạng tương tác:* AI sinh câu hỏi cho từng phân đoạn dựa trên transcript. Giảng viên cấu hình loại câu hỏi (trắc nghiệm, đúng/sai, câu hỏi mở; giai đoạn 2: lập trình, phát âm, nghe hiểu, luyện nói), độ khó, và số câu mỗi đoạn.

+ *Thiết lập tiêu chí đánh giá:* Giảng viên đặt điều kiện hoàn thành (ví dụ: xem ≥ 80% video, trả lời đúng ≥ 60%) và hạn nộp. Tiêu chí này kết hợp với bộ metrics đã định nghĩa ở Phần 1.

+ *Xem trước & phát hành:* Giảng viên trải nghiệm bài học dưới vai học viên, chỉnh sửa câu hỏi AI nếu cần, rồi phát hành đến lớp.

== Flow 2 — Thực hiện học tập

Luồng này diễn ra *trong lúc người học xem video*, hoạt động theo thời gian thực.

+ *Thực hiện học tập:* Người học xem video kèm phụ đề đồng bộ. Khi đến cuối mỗi phân đoạn, video tạm dừng và hiển thị câu hỏi. Người học bắt buộc phải trả lời trước khi tiếp tục — không có nút bỏ qua.

+ *Ghi nhận các tương tác:* Hệ thống ghi lại mọi sự kiện theo thời gian thực: thao tác xem (play, pause, seek, tốc độ phát), đáp án người học chọn/gõ, và thời gian phản hồi từ lúc câu hỏi xuất hiện đến lúc gửi đáp án.

+ *Ghi nhận kết quả học tập:* Hệ thống đánh giá tức thì (rule-based cho trắc nghiệm, LLM cho câu hỏi mở) và lưu kết quả: đúng/sai, điểm số, lời giải thích trích từ transcript. Nếu chưa hiểu, người học có thể hỏi chatbot AI — chatbot chỉ trả lời dựa trên nội dung bài giảng.

== Flow 3 — Phân tích tiến trình học

Luồng này diễn ra *sau khi học*, sử dụng dữ liệu từ Flow 2.

+ *Tổng hợp chỉ số:* Hệ thống tính toán bản đồ nhiệt (điểm trung bình theo từng phân đoạn), điểm tương tác (kết hợp thời gian xem + tỷ lệ phản hồi + điểm số), và phát hiện lỗ hổng (phân đoạn có điểm < 60%).

+ *Phản hồi cho người học:* Màn hình tổng kết hiển thị điểm số, bản đồ nhiệt cá nhân, và đề xuất xem lại các phân đoạn còn yếu.

+ *Báo cáo cho giảng viên:* Heatmap toàn lớp, danh sách học viên có nguy cơ tụt hậu, phân tích câu hỏi nào làm khó cả lớp nhất, và khả năng xem chi tiết từng học viên.
