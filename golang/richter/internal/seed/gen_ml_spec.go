package seed

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// gen_ml_spec.go is the Go replacement for scripts/seed/generate-ml-seed-data.py:
// it (re)generates the COMMITTED ML course seed artifacts (tu-hoc-ml.json +
// videos.json) by scanning the downloaded playlist videos. No python in the seed
// pipeline. The artifacts are then consumed by `seed --dev` like any other
// committed seed JSON.

// mlLessonMeta is the static authored metadata for each ML playlist entry, keyed
// by the NN- filename prefix produced by scripts/seed/download-ml-videos.py.
type mlLessonMeta struct {
	Title       string // original title (with "Bài X.Y:" — used in fixture text)
	Description string
}

var mlTitlesByPrefix = map[string]mlLessonMeta{
	"01": {"Bài 1.1: Các khái niệm cơ bản", "Giới thiệu các khái niệm cơ bản trong học máy (Machine Learning)."},
	"02": {"Bài 1.2: Bài toán học", "Định nghĩa bài toán học máy và các thành phần cốt lõi."},
	"03": {"Bài 1.3: Overfitting và Khả năng tổng quát hóa", "Khái niệm overfitting, underfitting và khả năng tổng quát hóa mô hình."},
	"04": {"Bài 2.1: Tiền xử lý dữ liệu (Phần 1)", "Giới thiệu các kỹ thuật xử lý dữ liệu thô, loại bỏ nhiễu."},
	"05": {"Bài 2.2: Tiền xử lý dữ liệu (Phần 2)", "Chuẩn hóa dữ liệu, mã hóa biến phân loại và xử lý dữ liệu khuyết."},
	"06": {"Bài 2.3: Tiền xử lý dữ liệu (Phần 3)", "Trích xuất và lựa chọn đặc trưng."},
	"07": {"Bài 3.1: Hồi quy tuyến tính", "Mô hình hồi quy tuyến tính một biến và nhiều biến."},
	"08": {"Bài 3.2: Phương pháp bình phương tối thiểu", "Ước lượng tham số hồi quy bằng phương pháp bình phương tối thiểu."},
	"09": {"Bài 3.3: Hồi quy Ridge", "Kỹ thuật regularization L2 (Ridge regression) để tránh overfitting."},
	"10": {"Bài 3.4: Hồi quy LASSO", "Kỹ thuật regularization L1 (LASSO regression) và lựa chọn đặc trưng."},
	"11": {"Bài 4.1: Phân cụm với K-means", "Thuật toán học không giám sát phân cụm K-means."},
	"12": {"Bài 5.1: Học dựa trên láng giềng (k-NN)", "Thuật toán phân loại và hồi quy dựa trên láng giềng gần nhất k-NN."},
	"13": {"Bài 6.1: Cây quyết định", "Xây dựng cây quyết định dựa trên độ đo entropy và thông tin thu được (information gain)."},
	"14": {"Bài 6.2: Rừng ngẫu nhiên", "Mô hình học máy kết hợp (ensemble learning) rừng ngẫu nhiên (Random Forest)."},
	"15": {"Bài 7.1: Phân loại bằng SVM (Phần 1)", "Thuật toán tối ưu biên lớn Support Vector Machine (SVM)."},
	"16": {"Bài 7.2: Phân loại bằng SVM (Phần 2)", "SVM phi tuyến và phương pháp sử dụng nhân (kernel trick)."},
	"17": {"Bài 8.1: Đánh giá hiệu quả của mô hình (Phần 1)", "Các độ đo đánh giá mô hình phân loại: Accuracy, Precision, Recall, F1-score."},
	"18": {"Bài 8.2: Đánh giá hiệu quả của mô hình (Phần 2)", "Đánh giá mô hình hồi quy và phương pháp kiểm chéo (cross-validation)."},
	"19": {"Bài 9.1: Mạng nơ-ron nhân tạo (Phần 1)", "Cấu tạo của một nơ-ron nhân tạo (Perceptron) và mạng truyền thẳng."},
	"20": {"Bài 9.2: Mạng nơ-ron nhân tạo (Phần 2)", "Thuật toán lan truyền ngược (Backpropagation) cập nhật trọng số."},
	"21": {"Bài 10.1: Mô hình xác suất", "Giới thiệu phương pháp phân loại dựa trên lý thuyết xác suất Bayes."},
	"22": {"Bài 10.2: Models and Generation Processes", "Mô hình sinh (Generative models) và quá trình sinh dữ liệu."},
	"23": {"Bài 10.3: Training and Inference", "Huấn luyện tham số và suy diễn xác suất trong mô hình học máy."},
	"24": {"Bài 10.4: Phân loại bằng Naive Bayes", "Phân loại văn bản và dữ liệu bằng thuật toán Naive Bayes."},
}

type mlChapter struct {
	Title    string
	Prefixes []string
}

var mlChapters = []mlChapter{
	{"Chương 1: Khái niệm cơ bản về Học máy", []string{"01", "02", "03"}},
	{"Chương 2: Tiền xử lý dữ liệu học máy", []string{"04", "05", "06"}},
	{"Chương 3: Các mô hình hồi quy tuyến tính", []string{"07", "08", "09", "10"}},
	{"Chương 4: Phân cụm dữ liệu", []string{"11"}},
	{"Chương 5: Học dựa trên khoảng cách", []string{"12"}},
	{"Chương 6: Cây quyết định và Rừng ngẫu nhiên", []string{"13", "14"}},
	{"Chương 7: Phân loại với SVM", []string{"15", "16"}},
	{"Chương 8: Đánh giá hiệu quả mô hình", []string{"17", "18"}},
	{"Chương 9: Mạng nơ-ron nhân tạo", []string{"19", "20"}},
	{"Chương 10: Mô hình học máy xác suất", []string{"21", "22", "23", "24"}},
}

var mlBaiPrefixRe = regexp.MustCompile(`^Bài\s+[\d.]+\s*:\s*`)

// GenMLSpecParams configures regeneration of the ML course seed artifacts.
type GenMLSpecParams struct {
	VideoDir       string // dir of NN-*.mp4 (default mlVideoDir)
	CourseJSONPath string // output course spec (default the committed tu-hoc-ml.json)
	VideosJSONPath string // output videos manifest (default the committed videos.json)
}

// GenMLSpec scans the downloaded ML playlist videos and (re)writes the committed
// tu-hoc-ml.json course spec + appends any new entries to videos.json idempotently.
// It writes source files (not the embedded FS), so run it from the repo root.
func (s *SeederSvc) GenMLSpec(ctx context.Context, p GenMLSpecParams) error {
	if p.VideoDir == "" {
		p.VideoDir = mlVideoDir
	}
	if p.CourseJSONPath == "" {
		p.CourseJSONPath = "golang/richter/internal/seed/data/dev/courses/tu-hoc-ml.json"
	}
	if p.VideosJSONPath == "" {
		p.VideosJSONPath = "golang/richter/internal/seed/data/dev/videos.json"
	}

	if _, err := os.Stat(p.VideoDir); err != nil {
		return fmt.Errorf("video dir %q not found — run scripts/seed/download-ml-videos.py first: %w", p.VideoDir, err)
	}
	files, err := filepath.Glob(filepath.Join(p.VideoDir, "*.mp4"))
	if err != nil {
		return fmt.Errorf("glob %q: %w", p.VideoDir, err)
	}
	sort.Strings(files)
	if len(files) == 0 {
		return fmt.Errorf("no .mp4 files in %q — run scripts/seed/download-ml-videos.py first", p.VideoDir)
	}
	s.log.InfoContext(ctx, "gen-ml-spec: scanning videos", "dir", p.VideoDir, "count", len(files))

	lessonsByPrefix := map[string]devLessonSpec{}
	var newVideos []devVideoSpec
	for _, fpath := range files {
		base := filepath.Base(fpath)
		prefix, _, _ := strings.Cut(base, "-")
		meta, ok := mlTitlesByPrefix[prefix]
		if !ok {
			s.log.WarnContext(ctx, "gen-ml-spec: unrecognized prefix, skipping", "file", base, "prefix", prefix)
			continue
		}
		// Store a CLEAN lesson title (the FE shows position from module/order; the
		// dotted "Bài 10.2:" form breaks the FE's single-number prefix stripper).
		cleanTitle := mlBaiPrefixRe.ReplaceAllString(meta.Title, "")
		dur := s.probeDurationSecs(ctx, fpath)
		s3Key := "seed/hust-cs/ml/" + base

		lessonsByPrefix[prefix] = devLessonSpec{
			Title:        cleanTitle,
			Description:  meta.Description,
			VideoKey:     s3Key,
			DurationSecs: dur,
			Analysis:     mlFixtureAnalysis(meta, dur),
		}
		newVideos = append(newVideos, devVideoSpec{LocalPath: fpath, S3Key: s3Key})
	}

	// Group into modules (chapters) in declared order.
	var modules []devModuleSpec
	for _, chap := range mlChapters {
		var lessons []devLessonSpec
		for _, pref := range chap.Prefixes {
			if l, ok := lessonsByPrefix[pref]; ok {
				lessons = append(lessons, l)
			}
		}
		if len(lessons) > 0 {
			modules = append(modules, devModuleSpec{Title: chap.Title, Lessons: lessons})
		}
	}

	course := []devCourseSpec{{
		OrgSlug:     mlOrgSlug,
		OwnerEmail:  "carol@dyadia.local",
		Title:       mlCourseTitle,
		Description: "Khóa học Tự học Machine Learning (Học máy) giới thiệu toàn diện các phương pháp học giám sát, học không giám sát, cây quyết định, hồi quy và học xác suất.",
		Status:      "published",
		Modules:     modules,
	}}
	if err := writeJSONIndented(p.CourseJSONPath, course); err != nil {
		return fmt.Errorf("write %q: %w", p.CourseJSONPath, err)
	}
	s.log.InfoContext(ctx, "gen-ml-spec: wrote course spec", "path", p.CourseJSONPath, "modules", len(modules))

	// Update videos.json idempotently (append only new s3 keys).
	var existing []devVideoSpec
	if raw, err := os.ReadFile(p.VideosJSONPath); err == nil {
		_ = json.Unmarshal(raw, &existing) // tolerate empty/garbage → start fresh
	}
	have := map[string]bool{}
	for _, v := range existing {
		have[v.S3Key] = true
	}
	added := 0
	for _, nv := range newVideos {
		if !have[nv.S3Key] {
			existing = append(existing, nv)
			have[nv.S3Key] = true
			added++
		}
	}
	if added > 0 {
		if err := writeJSONIndented(p.VideosJSONPath, existing); err != nil {
			return fmt.Errorf("write %q: %w", p.VideosJSONPath, err)
		}
	}
	s.log.InfoContext(ctx, "gen-ml-spec: videos manifest updated", "path", p.VideosJSONPath, "added", added, "total", len(existing))
	return nil
}

// mlFixtureAnalysis builds the golden-fixture analysis (placeholder transcript +
// 2 chunks + 2 MCQs) used when the real Whisper+Gemini pipeline is not run
// (test DB, or dev DB without the source video).
func mlFixtureAnalysis(meta mlLessonMeta, dur int32) *devAnalysisSpec {
	d := float64(dur)
	return &devAnalysisSpec{
		Transcript: fmt.Sprintf("Chào mừng các bạn đến với bài học %s. Trong bài này chúng ta sẽ tìm hiểu về %s Đây là phần nội dung văn bản giả lập được sử dụng để khớp với thời gian trong video.",
			meta.Title, strings.ToLower(meta.Description)),
		Chunks: []devChunkSpec{
			{StartSeconds: 0.0, EndSeconds: d / 2.0, Summary: "Phần 1: Giới thiệu kiến thức"},
			{StartSeconds: d / 2.0, EndSeconds: d, Summary: "Phần 2: Nội dung chi tiết"},
		},
		Questions: []devQuestionSpec{
			{
				QuestionText:  fmt.Sprintf("Câu hỏi ôn tập Phần 1 bài giảng: %s?", meta.Title),
				Options:       []string{"Lựa chọn A (Đúng)", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"},
				CorrectAnswer: 0,
				Explanation:   "Đây là câu trả lời đúng dựa trên nội dung Phần 1.",
				StartSeconds:  d / 4.0,
			},
			{
				QuestionText:  fmt.Sprintf("Câu hỏi ôn tập Phần 2 bài giảng: %s?", meta.Title),
				Options:       []string{"Lựa chọn A", "Lựa chọn B (Đúng)", "Lựa chọn C", "Lựa chọn D"},
				CorrectAnswer: 1,
				Explanation:   "Đây là câu trả lời đúng dựa trên nội dung Phần 2.",
				StartSeconds:  3.0 * d / 4.0,
			},
		},
	}
}

// probeDurationSecs returns the integer video duration via ffprobe, falling back
// to 600 (and warning) if ffprobe is unavailable or fails — never fatal.
func (s *SeederSvc) probeDurationSecs(ctx context.Context, path string) int32 {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		s.log.WarnContext(ctx, "gen-ml-spec: ffprobe failed, using 600s fallback", "file", path, "err", err)
		return 600
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		s.log.WarnContext(ctx, "gen-ml-spec: bad ffprobe duration, using 600s fallback", "file", path, "out", string(out))
		return 600
	}
	return int32(f)
}

func writeJSONIndented(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
