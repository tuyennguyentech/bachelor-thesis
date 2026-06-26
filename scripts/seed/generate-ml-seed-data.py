#!/usr/bin/env python3
import os
import sys
import json
import subprocess
import glob

VIDEO_DIR = "seed-assets/videos/ml"
COURSES_DIR = "golang/richter/internal/seed/data/dev/courses"
VIDEOS_JSON_PATH = "golang/richter/internal/seed/data/dev/videos.json"

titles_map = {
    "01": ("Bài 1.1: Các khái niệm cơ bản", "Giới thiệu các khái niệm cơ bản trong học máy (Machine Learning)."),
    "02": ("Bài 1.2: Bài toán học", "Định nghĩa bài toán học máy và các thành phần cốt lõi."),
    "03": ("Bài 1.3: Overfitting và Khả năng tổng quát hóa", "Khái niệm overfitting, underfitting và khả năng tổng quát hóa mô hình."),
    "04": ("Bài 2.1: Tiền xử lý dữ liệu (Phần 1)", "Giới thiệu các kỹ thuật xử lý dữ liệu thô, loại bỏ nhiễu."),
    "05": ("Bài 2.2: Tiền xử lý dữ liệu (Phần 2)", "Chuẩn hóa dữ liệu, mã hóa biến phân loại và xử lý dữ liệu khuyết."),
    "06": ("Bài 2.3: Tiền xử lý dữ liệu (Phần 3)", "Trích xuất và lựa chọn đặc trưng."),
    "07": ("Bài 3.1: Hồi quy tuyến tính", "Mô hình hồi quy tuyến tính một biến và nhiều biến."),
    "08": ("Bài 3.2: Phương pháp bình phương tối thiểu", "Ước lượng tham số hồi quy bằng phương pháp bình phương tối thiểu."),
    "09": ("Bài 3.3: Hồi quy Ridge", "Kỹ thuật regularization L2 (Ridge regression) để tránh overfitting."),
    "10": ("Bài 3.4: Hồi quy LASSO", "Kỹ thuật regularization L1 (LASSO regression) và lựa chọn đặc trưng."),
    "11": ("Bài 4.1: Phân cụm với K-means", "Thuật toán học không giám sát phân cụm K-means."),
    "12": ("Bài 5.1: Học dựa trên láng giềng (k-NN)", "Thuật toán phân loại và hồi quy dựa trên láng giềng gần nhất k-NN."),
    "13": ("Bài 6.1: Cây quyết định", "Xây dựng cây quyết định dựa trên độ đo entropy và thông tin thu được (information gain)."),
    "14": ("Bài 6.2: Rừng ngẫu nhiên", "Mô hình học máy kết hợp (ensemble learning) rừng ngẫu nhiên (Random Forest)."),
    "15": ("Bài 7.1: Phân loại bằng SVM (Phần 1)", "Thuật toán tối ưu biên lớn Support Vector Machine (SVM)."),
    "16": ("Bài 7.2: Phân loại bằng SVM (Phần 2)", "SVM phi tuyến và phương pháp sử dụng nhân (kernel trick)."),
    "17": ("Bài 8.1: Đánh giá hiệu quả của mô hình (Phần 1)", "Các độ đo đánh giá mô hình phân loại: Accuracy, Precision, Recall, F1-score."),
    "18": ("Bài 8.2: Đánh giá hiệu quả của mô hình (Phần 2)", "Đánh giá mô hình hồi quy và phương pháp kiểm chéo (cross-validation)."),
    "19": ("Bài 9.1: Mạng nơ-ron nhân tạo (Phần 1)", "Cấu tạo của một nơ-ron nhân tạo (Perceptron) và mạng truyền thẳng."),
    "20": ("Bài 9.2: Mạng nơ-ron nhân tạo (Phần 2)", "Thuật toán lan truyền ngược (Backpropagation) cập nhật trọng số."),
    "21": ("Bài 10.1: Mô hình xác suất", "Giới thiệu phương pháp phân loại dựa trên lý thuyết xác suất Bayes."),
    "22": ("Bài 10.2: Models and Generation Processes", "Mô hình sinh (Generative models) và quá trình sinh dữ liệu."),
    "23": ("Bài 10.3: Training and Inference", "Huấn luyện tham số và suy diễn xác suất trong mô hình học máy."),
    "24": ("Bài 10.4: Phân loại bằng Naive Bayes", "Phân loại văn bản và dữ liệu bằng thuật toán Naive Bayes.")
}

chapters = [
    {"title": "Chương 1: Khái niệm cơ bản về Học máy", "prefixes": ["01", "02", "03"]},
    {"title": "Chương 2: Tiền xử lý dữ liệu học máy", "prefixes": ["04", "05", "06"]},
    {"title": "Chương 3: Các mô hình hồi quy tuyến tính", "prefixes": ["07", "08", "09", "10"]},
    {"title": "Chương 4: Phân cụm dữ liệu", "prefixes": ["11"]},
    {"title": "Chương 5: Học dựa trên khoảng cách", "prefixes": ["12"]},
    {"title": "Chương 6: Cây quyết định và Rừng ngẫu nhiên", "prefixes": ["13", "14"]},
    {"title": "Chương 7: Phân loại với SVM", "prefixes": ["15", "16"]},
    {"title": "Chương 8: Đánh giá hiệu quả mô hình", "prefixes": ["17", "18"]},
    {"title": "Chương 9: Mạng nơ-ron nhân tạo", "prefixes": ["19", "20"]},
    {"title": "Chương 10: Mô hình học máy xác suất", "prefixes": ["21", "22", "23", "24"]}
]

def get_duration(filepath):
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filepath
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return int(float(res.stdout.strip()))
    except Exception as e:
        print(f"Error getting duration for {filepath}: {e}", file=sys.stderr)
        return 600 # default fallback

def main():
    if not os.path.exists(VIDEO_DIR):
        print(f"Directory {VIDEO_DIR} does not exist. Please download videos first.", file=sys.stderr)
        sys.exit(1)

    video_files = glob.glob(os.path.join(VIDEO_DIR, "*.mp4"))
    video_files.sort()
    
    if not video_files:
        print("No MP4 files found in the videos directory.", file=sys.stderr)
        sys.exit(1)

    print(f"Scanning {len(video_files)} video files...")
    
    # Store video metadata mapped by prefix
    lessons_by_prefix = {}
    
    new_video_specs = []
    
    for fpath in video_files:
        basename = os.path.basename(fpath)
        prefix = basename.split("-")[0]
        if prefix not in titles_map:
            print(f"Warning: Prefix {prefix} not recognized in titles_map. Skipping.")
            continue
            
        title, desc = titles_map[prefix]
        duration = get_duration(fpath)
        
        s3_key = f"seed/hust-cs/ml/{basename}"
        
        # Build analysis spec with at least 1 question per chunk
        # Let's create exactly 2 chunks, and 1 question in each chunk
        analysis = {
            "transcript": f"Chào mừng các bạn đến với bài học {title}. Trong bài này chúng ta sẽ tìm hiểu về {desc.lower()} Đây là phần nội dung văn bản giả lập được sử dụng để khớp với thời gian trong video.",
            "chunks": [
                {
                    "start_seconds": 0.0,
                    "end_seconds": float(duration / 2.0),
                    "summary": "Phần 1: Giới thiệu kiến thức"
                },
                {
                    "start_seconds": float(duration / 2.0),
                    "end_seconds": float(duration),
                    "summary": "Phần 2: Nội dung chi tiết"
                }
            ],
            "questions": [
                {
                    "question_text": f"Câu hỏi ôn tập Phần 1 bài giảng: {title}?",
                    "options": ["Lựa chọn A (Đúng)", "Lựa chọn B", "Lựa chọn C", "Lựa chọn D"],
                    "correct_answer": 0,
                    "explanation": "Đây là câu trả lời đúng dựa trên nội dung Phần 1.",
                    "start_seconds": float(duration / 4.0)
                },
                {
                    "question_text": f"Câu hỏi ôn tập Phần 2 bài giảng: {title}?",
                    "options": ["Lựa chọn A", "Lựa chọn B (Đúng)", "Lựa chọn C", "Lựa chọn D"],
                    "correct_answer": 1,
                    "explanation": "Đây là câu trả lời đúng dựa trên nội dung Phần 2.",
                    "start_seconds": float(3.0 * duration / 4.0)
                }
            ]
        }
        
        lessons_by_prefix[prefix] = {
            "title": title,
            "description": desc,
            "video_key": s3_key,
            "duration_secs": duration,
            "analysis": analysis
        }
        
        new_video_specs.append({
            "local_path": fpath,
            "s3_key": s3_key
        })

    # Group into modules (chapters)
    modules = []
    for chap in chapters:
        mod_lessons = []
        for pref in chap["prefixes"]:
            if pref in lessons_by_prefix:
                mod_lessons.append(lessons_by_prefix[pref])
        
        if mod_lessons:
            modules.append({
                "title": chap["title"],
                "lessons": mod_lessons
            })

    course_spec = {
        "org_slug": "hust-cs",
        "owner_email": "carol@dyadia.local",
        "title": "Tự học Machine Learning",
        "description": "Khóa học Tự học Machine Learning (Học máy) giới thiệu toàn diện các phương pháp học giám sát, học không giám sát, cây quyết định, hồi quy và học xác suất.",
        "status": "published",
        "modules": modules
    }

    # Save to courses directory
    course_json_path = os.path.join(COURSES_DIR, "tu-hoc-ml.json")
    with open(course_json_path, "w", encoding="utf-8") as out_f:
        json.dump([course_spec], out_f, ensure_ascii=False, indent=2)
    print(f"Saved course spec to {course_json_path}")

    # Update videos.json idempotently
    existing_videos = []
    if os.path.exists(VIDEOS_JSON_PATH):
        with open(VIDEOS_JSON_PATH, "r", encoding="utf-8") as vf:
            try:
                existing_videos = json.load(vf)
            except Exception as e:
                print(f"Warning reading videos.json: {e}")
                existing_videos = []

    # Map existing local paths/s3_keys for quick check
    existing_keys = {v["s3_key"] for v in existing_videos}
    
    added_count = 0
    for nv in new_video_specs:
        if nv["s3_key"] not in existing_keys:
            existing_videos.append(nv)
            added_count += 1
            
    if added_count > 0:
        with open(VIDEOS_JSON_PATH, "w", encoding="utf-8") as out_vf:
            json.dump(existing_videos, out_vf, ensure_ascii=False, indent=2)
        print(f"Added {added_count} new videos to {VIDEOS_JSON_PATH}")
    else:
        print(f"No new videos needed to add to {VIDEOS_JSON_PATH}")

if __name__ == "__main__":
    main()
