// ─── chapters/ch4-use-cases.typ ──────────────────────────────────────────────
// Phần 4: Đặc tả sản phẩm

#import "../helpers.typ": badge, tbl, scenario

= Đặc tả sản phẩm

== Product Vision

*Tầm nhìn:* Biến video bài giảng thành trải nghiệm học tập chủ động — AI tự động sinh câu hỏi bám sát nội dung và phản hồi tức thì, giúp người học ghi nhớ sâu hơn thay vì xem thụ động.

*Vấn đề:* Người học xem video thụ động, tỷ lệ ghi nhớ thấp, không có cơ chế kiểm tra trong lúc học.

*Giải pháp:* Chia nhỏ video → AI sinh câu hỏi tại mỗi điểm chuyển giao kiến thức → buộc trả lời trước khi tiếp tục → phản hồi ngay lập tức.

== Đối tượng người dùng

#tbl(
  (2.5cm, 1fr, 4cm),
  ("Vai trò", "Nhu cầu chính", "Quyền hạn"),
  (
    [*Học viên*], [Học theo lộ trình, nhận phản hồi tức thì], [Xem video, trả lời câu hỏi, chat AI, xem kết quả],
    [*Giảng viên*], [Tải nội dung, theo dõi lớp], [Quản lý video/lớp, xem số liệu toàn lớp],
    [*Người tự học*], [Tự đưa video vào để học], [Tải video cá nhân, trải nghiệm học tập riêng tư],
  )
)

== User Stories

=== Giảng viên

+ Là giảng viên, tôi muốn *tải video lên để AI tự động sinh câu hỏi*, vì tôi không có thời gian soạn thủ công.
+ Là giảng viên, tôi muốn *xem trước và chỉnh sửa câu hỏi AI* trước khi phát hành.
+ Là giảng viên, tôi muốn *xem kết quả học tập của lớp* để biết phân đoạn nào cần giảng lại.

=== Học viên

+ Là học viên, tôi muốn *xem video kèm phụ đề đồng bộ* để dễ theo dõi.
+ Là học viên, tôi muốn *trả lời câu hỏi và nhận phản hồi ngay* để biết mình hiểu đúng hay sai.
+ Là học viên, tôi muốn *hỏi chatbot AI khi chưa hiểu* để được giải thích thêm.

=== Người tự học

+ Là người tự học, tôi muốn *dán URL YouTube hoặc tải video lên* để hệ thống biến nó thành bài học tương tác.

== Đặc tả yêu cầu (Use Case)

=== UC-01: Giảng viên tạo và phát hành bài học

#scenario(
  "UC-01", "Tác nhân: Giảng viên",
  "Giảng viên đã đăng nhập, có sẵn video bài giảng hoặc URL video.",
  (
    [Tải video lên hoặc dán URL. Hệ thống tự động tạo transcript và phân đoạn.],
    [Rà soát transcript, chỉnh sửa thuật ngữ nếu cần.],
    [Cấu hình loại câu hỏi và độ khó. AI sinh câu hỏi cho từng phân đoạn.],
    [Xem trước bài học, chỉnh sửa câu hỏi AI nếu chưa phù hợp.],
    [Phát hành bài học đến lớp kèm deadline.],
  )
)

=== UC-02: Học viên xem video và tương tác

#scenario(
  "UC-02", "Tác nhân: Học viên",
  "Học viên đã đăng nhập, có bài học được giao.",
  (
    [Mở bài học. Video phát kèm phụ đề đồng bộ.],
    [Khi đến cuối phân đoạn, video dừng và hiển thị câu hỏi. Bắt buộc trả lời mới được xem tiếp.],
    [Hệ thống phản hồi tức thì: đúng/sai, giải thích, trích dẫn đoạn video liên quan.],
    [Nếu chưa hiểu, hỏi chatbot AI. Chatbot chỉ trả lời dựa trên nội dung bài giảng.],
    [Xem hết video → màn hình tổng kết hiển thị điểm số và các lỗ hổng kiến thức.],
  )
)

=== UC-03: Người tự học thêm video cá nhân

#scenario(
  "UC-03", "Tác nhân: Người tự học",
  "Người tự học tìm thấy video trên internet và muốn dùng AI để học.",
  (
    [Dán URL YouTube hoặc tải video lên thư viện cá nhân.],
    [Hệ thống xử lý tự động (tương tự UC-01). Trải nghiệm học tương tự UC-02.],
    [Mọi dữ liệu hoàn toàn riêng tư.],
  )
)

=== UC-04: Giảng viên xem báo cáo lớp

#scenario(
  "UC-04", "Tác nhân: Giảng viên",
  "Khóa học đã diễn ra, giảng viên cần xem tình hình học tập.",
  (
    [Truy cập không gian phân tích học tập của lớp.],
    [Xem heatmap toàn lớp: phân đoạn nào cả lớp yếu, câu hỏi nào khó nhất.],
    [Xem chi tiết từng học viên: lịch sử xem, kết quả trả lời.],
  )
)

== Feature Matrix (MVP)

#tbl(
  (1fr, 1.5cm),
  ("Tính năng", [#badge(rgb("#0F6E56"), "MVP")]),
  (
    [Đăng ký / đăng nhập (Google OAuth, email/password)], [✓],
    [Phân quyền: học viên · giảng viên · tự học], [✓],
    [Tải video từ máy tính hoặc URL (YouTube, Vimeo)], [✓],
    [Tự động tạo transcript (Speech-to-Text)], [✓],
    [Chỉnh sửa transcript trực tiếp], [✓],
    [AI sinh câu hỏi trắc nghiệm / đúng-sai / câu hỏi mở], [✓],
    [Xem trước và chỉnh sửa câu hỏi AI], [✓],
    [Video player với phụ đề đồng bộ], [✓],
    [Tạm dừng video + hiển thị câu hỏi tại điểm chuyển giao], [✓],
    [Đánh giá tức thì (rule-based + LLM)], [✓],
    [Chatbot Q&A dựa trên nội dung bài giảng], [✓],
    [Tạo lớp học, giao bài, đặt deadline], [✓],
    [Kết quả học tập: điểm số, tỷ lệ hoàn thành], [✓],
    [Thư viện video cá nhân (người tự học)], [✓],
  )
)
