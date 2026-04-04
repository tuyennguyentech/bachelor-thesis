// ─── chapters/ch1-learning-science.typ ───────────────────────────────────────
// Phần 1: Căn cứ khoa học — Mô hình học tập & Bằng chứng hiệu quả

#import "../helpers.typ": hl, tbl

= Căn cứ khoa học — Mô hình học tập & Bằng chứng hiệu quả

== Bối cảnh và vấn đề

Hầu hết các nền tảng học trực tuyến (e-learning) hiện nay đều cung cấp video bài giảng dưới dạng tuyến tính. Điều này đồng nghĩa với việc người học chỉ tiếp nhận thông tin một cách thụ động từ đầu đến cuối bài mà không có sự tương tác. Các nghiên cứu trong lĩnh vực khoa học nhận thức đã chỉ ra rằng, phương pháp học thụ động này mang lại tỷ lệ ghi nhớ rất thấp; thậm chí, theo nghiên cứu kinh điển về đường cong lãng quên của Ebbinghaus, người học có thể quên phần lớn lượng kiến thức chỉ sau 24 giờ nếu không có các biện pháp ôn tập kịp thời. Để giải quyết triệt để vấn đề này, hệ thống đề xuất áp dụng kỹ thuật *Interpolated Retrieval Practice* (IRP) — phương pháp nhúng các câu hỏi do AI tạo ra vào ngay giữa quá trình phát video, buộc người học phải liên tục vận động trí não để truy xuất thông tin thay vì chỉ nghe giảng thụ động.

== Các mô hình học tập làm căn cứ

=== Cognitive Load Theory (Thuyết tải nhận thức)

Lý thuyết tải nhận thức của Sweller #link(<ref-1>)[\[1\]] chia nỗ lực của não bộ thành ba loại: *tải nội tại* (độ khó của bản thân kiến thức), *tải ngoại lai* (gánh nặng do bài giảng trình bày kém gây ra), và *tải hữu ích* (nỗ lực cần thiết để não bộ thực sự hiểu và ghi nhớ kiến thức). Gần đây, nghiên cứu thần kinh học của Gkintoni et al. #link(<ref-10>)[\[10\]] cũng khẳng định rằng khi tổng tải nhận thức vượt quá giới hạn, hoạt động của vỏ não trước trán (PFC) sẽ bị suy giảm, gây ra sự mệt mỏi và làm giảm sút năng suất học tập.

#hl(rgb("#2E75B6"))[
  *Ứng dụng vào hệ thống:* Khéo léo chia nhỏ video dài thành các phân đoạn (chunk) từ 5–10 phút. Tại các điểm chuyển tiếp này, AI sẽ đưa ra câu hỏi nhằm đóng gói kiến thức lại, duy trì "tải hữu ích" ở mức tối ưu và ngăn chặn tình trạng quá tải nhận thức do nhồi nhét liên tục.
]

=== Retrieval Practice Effect (Hiệu ứng truy xuất)

Hai nghiên cứu phân tích gộp (meta-analysis) quy mô lớn đã chứng minh tính ưu việt của phương pháp thực hành truy xuất. Rowland #link(<ref-11>)[\[11\]] ghi nhận kích thước hiệu ứng (effect size) đạt mức *g = 0.50* khi so sánh việc làm bài kiểm tra gợi nhớ kiến thức so với việc chỉ đọc lại tài liệu; trong khi Adesope et al. #link(<ref-12>)[\[12\]] ghi nhận mức *g = 0.61* khi so sánh với mọi phương pháp học tập khác. Thay vì chỉ đọc lướt để tạo ra cảm giác "nhìn quen quen" (*familiarity memory*), việc buộc não bộ phải lục lọi và trả lời câu hỏi sẽ giúp hình thành các liên kết thần kinh bền vững, tạo ra trí nhớ truy hồi sâu (*recollective memory*).

Nghiên cứu mới nhất của Rivers et al. #link(<ref-5>)[\[5\]] cũng nhấn mạnh rằng đối với các nội dung học thuật phức tạp, *truy xuất tường minh* (tức là người học phải gõ hoặc nhấp chọn câu trả lời thực sự) mang lại hiệu quả vượt trội so với *truy xuất ngầm* (chỉ nhẩm câu trả lời trong đầu).

#hl(rgb("#0F6E56"))[
  *Ứng dụng vào hệ thống:* Hệ thống sẽ tạm dừng video và bắt buộc người học phải thực hiện thao tác chọn hoặc gõ câu trả lời (truy xuất tường minh). Thiết kế này không cho phép người học bấm bỏ qua (click-through) nếu chưa đưa ra phản hồi.
]

=== Interpolated Retrieval Practice (IRP)

Sự kết hợp giữa chia nhỏ video và câu hỏi truy xuất chính là cốt lõi của phương pháp IRP. Một nghiên cứu trực tiếp về vấn đề này của Assadipour et al. #link(<ref-3>)[\[3\]] yêu cầu người học xem một video chủ đề STEM được chia làm 3 đoạn (5 phút/đoạn). Kết quả chỉ ra rằng, chỉ có loại câu hỏi "truy xuất theo đúng giai đoạn vừa học" (episodic retrieval) mới giúp cải thiện thành tích. Điều này mang lại một triết lý thiết kế hệ trọng: AI phải sinh câu hỏi *bám sát vào nội dung đoạn video vừa được phát*, tuyệt đối tránh các câu hỏi mang tính khái quát xa rời ngữ cảnh.

Hơn thế nữa, thử nghiệm ngẫu nhiên có đối chứng (RCT) của Chan et al. #link(<ref-2>)[\[2\]] trên 703 sinh viên đã chứng minh rằng: Việc nhúng các câu hỏi vào giữa bài giảng có khả năng "kéo" sự tập trung của người học quay lại, kể cả khi họ đang cố tình bị xao nhãng bởi các ứng dụng giải trí như TikTok.

#hl(rgb("#6C3483"))[
  *Ứng dụng vào hệ thống:* Hệ thống tự động bóc tách phụ đề của chính phân đoạn video đang phát để làm ngữ cảnh đầu vào cho AI sinh câu hỏi. Người học phải vận dụng trí nhớ ngắn hạn giải quyết ngay câu hỏi đó, giúp họ chống lại các cơn xao nhãng trong môi trường học trực tuyến.
]

== Bằng chứng hiệu quả từ nghiên cứu thực nghiệm

#tbl(
  (2.8cm, 1fr, 4.5cm),
  ("Nguồn", "Đối tượng & Phương pháp nghiên cứu", "Kết luận rút ra cho hệ thống"),
  (
    [Chan et al. #link(<ref-2>)[\[2\]]], [Thử nghiệm RCT trên 703 sinh viên, so sánh việc học nhúng câu hỏi giữa bài với nhóm học bị xao nhãng bởi TikTok.], [Việc nhúng câu hỏi (IRP) giúp duy trì sự tập trung, chống lại xao nhãng và tăng cường khả năng ghi nhớ dài hạn.],
    [Assadipour et al. #link(<ref-3>)[\[3\]]], [Thực nghiệm trên ~500 người học, chia nhỏ video STEM thành 3 đoạn và đánh giá tác động của các loại câu hỏi.], [Câu hỏi do AI sinh ra bắt buộc phải bám sát nội dung đoạn video vừa phát mới mang lại hiệu quả tiếp thu thực sự.],
    [Kestin et al. #link(<ref-4>)[\[4\]]], [Thử nghiệm đối chứng ngẫu nhiên (RCT) tại ĐH Harvard, so sánh giữa tự học cùng gia sư AI và học trên giảng đường.], [Hệ thống học qua AI (nếu thiết kế chuẩn sư phạm) đem lại điểm số và độ gắn kết cao hơn học trực tiếp truyền thống.],
    [Adesope et al. #link(<ref-12>)[\[12\]]], [Phân tích gộp quy mô lớn so sánh phương pháp làm bài kiểm tra gợi nhớ (truy xuất) với các kỹ thuật học tập khác.], [Thực hành trả lời câu hỏi là phương pháp mang lại hiệu suất ghi nhớ cao nhất ($g=0.61$) trong tất cả các cách học.],
  )
)

== Khó khăn và thách thức

=== Chất lượng câu hỏi AI

Khi ứng dụng AI tạo câu hỏi tự động, Al Faraby et al. #link(<ref-6>)[\[6\]] đã chỉ ra hai vấn đề cốt lõi của các Mô hình ngôn ngữ lớn (LLM): Thứ nhất, LLM rất dễ sử dụng lượng kiến thức khổng lồ có sẵn của nó thay vì bám sát vào nội dung bài giảng, dẫn đến "ảo giác" (*faithfulness hallucination*). Thứ hai, LLM thường lúng túng khi phải điều chỉnh độ khó của câu hỏi theo thang nhận thức Bloom. Ngoài ra, Durgungoz & Durgungoz #link(<ref-8>)[\[8\]] cũng cảnh báo rằng câu hỏi do AI sinh ra ở thời điểm hiện tại vẫn cần một bước hậu kiểm từ giảng viên trước khi đưa vào đánh giá sinh viên chính thức.

=== Trải nghiệm người dùng

Việc video bị ngắt quãng liên tục bởi các câu hỏi có nguy cơ gây ra sự ức chế (frustration) cho người học, làm gãy mạch cảm xúc đối với những bài giảng mang tính kể chuyện. Thêm vào đó, nếu câu hỏi quá dễ hoặc không có cơ chế bắt buộc, người học sẽ có xu hướng bấm "bỏ qua" theo phản xạ. Nghiên cứu về hệ thống tự sinh câu hỏi của Thüs et al. #link(<ref-9>)[\[9\]] đã chứng minh rằng *chất lượng* và ngữ cảnh của tương tác đóng vai trò quan trọng hơn nhiều so với việc cố tình tăng *số lượng* tương tác vô nghĩa.

=== Đánh giá và đo lường

Hầu hết các nghiên cứu hiện tại mới chỉ tập trung vào nhóm người trưởng thành học các khối ngành kỹ thuật (STEM) tại phương Tây, do đó vẫn còn thiếu đi những góc nhìn thực tế tại môi trường giáo dục Việt Nam. Hơn nữa, kết quả làm câu hỏi trắc nghiệm ngay trong lúc học chưa chắc đã phản ánh đúng khả năng lưu giữ kiến thức lâu dài. Điều này đòi hỏi hệ thống phải có các thiết kế bài kiểm tra độ trễ (delayed posttest) để thu thập được các số liệu phân tích độ hiệu quả thực sự khách quan.

=== Bias ngôn ngữ và văn hóa

Mô hình LLM khi xử lý và sinh câu hỏi từ văn bản tiếng Việt hoàn toàn có khả năng vấp phải các vấn đề về thiên kiến văn hóa hoặc diễn đạt thiếu tự nhiên. Một nghiên cứu của Xu et al. #link(<ref-7>)[\[7\]] cho thấy sinh viên thường có xu hướng đánh giá các nội dung do AI tạo ra "thiếu sự thu hút" hơn một chút so với văn phong của giáo viên thật. Do vậy, một công cụ cho phép giảng viên can thiệp và chỉnh sửa văn bản của AI trước khi phát hành là tính năng bắt buộc phải có đối với nền tảng.

== Xây dựng mô hình học tập dựa trên video

Các nghiên cứu đã khảo sát ở trên cung cấp hai kết quả cốt lõi có thể chuyển hóa trực tiếp thành các thành phần của mô hình: (i) chia nhỏ nội dung giúp kiểm soát tải nhận thức #link(<ref-1>)[\[1\]] #link(<ref-10>)[\[10\]], và (ii) câu hỏi truy xuất tường minh nhúng giữa bài giảng (IRP) cải thiện ghi nhớ với effect size lớn #link(<ref-11>)[\[11\]] #link(<ref-12>)[\[12\]] #link(<ref-3>)[\[3\]]. Hai kết quả này bổ trợ lẫn nhau: phân đoạn tạo đơn vị nội dung vừa đủ cho câu hỏi truy xuất, kết quả truy xuất phản ánh mức độ tiếp thu của người học. Dựa trên logic này, mô hình đề xuất gồm hai giai đoạn nối tiếp.

=== Giai đoạn 1 — Phân đoạn video & kiểm soát tải nhận thức

Cognitive Load Theory #link(<ref-1>)[\[1\]] chỉ ra rằng bộ nhớ làm việc chỉ xử lý hiệu quả một lượng thông tin giới hạn tại mỗi thời điểm; khi tổng tải vượt ngưỡng, hoạt động vỏ não trước trán suy giảm #link(<ref-10>)[\[10\]]. Từ kết quả này, mô hình chia video bài giảng thành các phân đoạn 5–10 phút, với điểm cắt đặt tại các mốc chuyển tiếp tự nhiên của nội dung (khoảng lặng, chuyển chủ đề). Mỗi phân đoạn chứa một đơn vị kiến thức khép kín, đủ nhỏ để não bộ xử lý trọn vẹn mà không rơi vào quá tải, đồng thời đủ lớn để mang một ý nghĩa trọn vẹn.

*Đánh giá:* Tỷ lệ hoàn thành video (thời gian xem thực tế / tổng thời lượng) — nếu phân đoạn quá dài hoặc cắt sai chỗ, người học sẽ bỏ ngang giữa chừng.

=== Giai đoạn 2 — Truy xuất tường minh tại chỗ (Interpolated Retrieval Practice)

Kết quả từ Assadipour et al. #link(<ref-3>)[\[3\]] cho thấy chỉ loại câu hỏi bám sát nội dung đoạn vừa học mới cải thiện thành tích, còn câu hỏi khái quát không có tác dụng. Rivers et al. #link(<ref-5>)[\[5\]] bổ sung rằng truy xuất tường minh (người học phải gõ hoặc chọn đáp án) vượt trội so với truy xuất ngầm (chỉ nhẩm trong đầu). Chan et al. #link(<ref-2>)[\[2\]] chứng minh thêm rằng câu hỏi nhúng giữa bài giảng có khả năng kéo sự tập trung quay lại ngay cả khi người học đang bị xao nhãng.

Tổng hợp ba kết quả trên, mô hình áp dụng cơ chế: tại cuối mỗi phân đoạn, video tạm dừng và AI sinh câu hỏi dựa trên transcript của chính đoạn vừa phát. Người học bắt buộc phải chọn hoặc gõ câu trả lời trước khi video tiếp tục — không có nút bỏ qua. Hệ thống phản hồi ngay lập tức kết quả đúng/sai, kèm giải thích ngắn gọn và trích dẫn đến mốc thời gian tương ứng trong video.

== Tiêu chí đánh giá kết quả mô hình

Giai đoạn 2 của mô hình hỗ trợ nhiều loại tương tác khác nhau, mỗi loại đòi hỏi các độ đo riêng. Phần này xác định tiêu chí đánh giá cho từng thành phần, chia thành ba nhóm: mức độ gắn kết của người học, hiệu quả tiếp thu theo từng loại tương tác, và chất lượng nội dung do AI sinh ra.

=== Nhóm 1 — Mức độ gắn kết (Engagement)

Các chỉ số này đo lường hành vi xem và tương tác, áp dụng chung cho toàn bộ mô hình bất kể loại câu hỏi.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Tỷ lệ hoàn thành video], [Người học có xem hết bài giảng hay bỏ dở giữa chừng.], [Thời gian xem thực tế / tổng thời lượng video],
    [Tỷ lệ phản hồi câu hỏi], [Người học có thực sự tương tác với câu hỏi hay chỉ chờ timeout.], [Số câu hỏi được trả lời / tổng số câu hỏi xuất hiện],
    [Thời gian phản hồi trung bình], [Phản ánh mức độ suy nghĩ: quá nhanh có thể là đoán mò, quá chậm có thể là không hiểu.], [Trung bình thời gian từ lúc câu hỏi hiển thị đến lúc người học gửi đáp án],
  )
)

=== Nhóm 2 — Hiệu quả tiếp thu theo loại tương tác

Mỗi loại tương tác kiểm tra một khía cạnh khác nhau của việc tiếp thu kiến thức, do đó cần các độ đo phù hợp.

*Trắc nghiệm & Đúng/Sai* — Kiểm tra khả năng nhận diện và ghi nhớ thông tin.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Tỷ lệ trả lời đúng], [Chỉ số cốt lõi, phản ánh mức độ tiếp thu nội dung.], [Số câu đúng / tổng số câu hỏi trong phân đoạn],
    [Phân bố đáp án sai], [Xác định quan niệm sai phổ biến (misconception) của người học.], [Tần suất chọn từng phương án sai, theo từng câu hỏi],
  )
)

*Câu hỏi mở* — Kiểm tra khả năng diễn đạt và hiểu sâu.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Điểm ngữ nghĩa], [Câu trả lời có đúng ý so với nội dung bài giảng hay không.], [LLM chấm điểm 0–1 dựa trên ngữ cảnh transcript],
    [Độ dài phản hồi], [Người học trả lời qua loa hay thực sự diễn đạt.], [Số từ trung bình trong câu trả lời],
  )
)

*Lập trình (Giai đoạn 2)* — Kiểm tra khả năng vận dụng kiến thức vào thực hành.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Tỷ lệ vượt test case], [Mã nguồn có chạy đúng yêu cầu hay không.], [Số test case pass / tổng số test case],
    [Số lần thử], [Người học có giải được ngay hay phải sửa nhiều lần.], [Số lần submit cho đến khi pass toàn bộ],
  )
)

*Luyện phát âm (Giai đoạn 2)* — Kiểm tra kỹ năng phát âm qua so sánh với bản chuẩn.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Điểm phát âm], [Mức độ chính xác khi phát âm từng âm tiết.], [Điểm từ Web Speech API hoặc mô hình đánh giá phát âm (0–100)],
    [Tỷ lệ từ phát âm đúng], [Bao nhiêu phần trăm từ trong câu được phát âm chấp nhận được.], [Số từ đạt ngưỡng / tổng số từ trong câu mẫu],
  )
)

*Nghe hiểu (Giai đoạn 2)* — Kiểm tra khả năng tiếp thu khi chỉ nghe, không có phụ đề hỗ trợ.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Tỷ lệ trả lời đúng (không phụ đề)], [Khả năng hiểu nội dung chỉ qua thính giác.], [Số câu đúng / tổng số câu hỏi nghe hiểu],
    [Số lần nghe lại], [Người học có cần replay nhiều lần hay hiểu ngay từ lần đầu.], [Tổng số lần replay đoạn audio trước khi trả lời],
  )
)

*Luyện nói (Giai đoạn 2)* — Kiểm tra khả năng trình bày bằng lời.

#tbl(
  (3.5cm, 1fr, 4cm),
  ("Tiêu chí", "Ý nghĩa", "Cách đo"),
  (
    [Điểm nội dung], [Phần trình bày có bao quát đủ ý chính từ bài giảng hay không.], [LLM so sánh bản bóc băng với nội dung phân đoạn (0–1)],
    [Độ trôi chảy], [Người học nói có mạch lạc hay ngắt quãng, ậm ừ nhiều.], [Tỷ lệ từ chêm xen (uh, um, à) / tổng số từ],
  )
)

#hl(rgb("#1F5C99"))[
  *Tóm lại:* Mô hình gồm hai giai đoạn nối tiếp: phân đoạn video → truy xuất tường minh tại chỗ. Hiệu quả được đánh giá qua hai nhóm tiêu chí: mức độ gắn kết (tỷ lệ hoàn thành, tỷ lệ phản hồi, thời gian phản hồi) và hiệu quả tiếp thu riêng cho từng loại tương tác (trắc nghiệm, câu hỏi mở, lập trình, phát âm, nghe hiểu, luyện nói). Toàn bộ quy trình được tự động hóa bằng AI và diễn ra ngay trong quá trình người học xem video.
]
