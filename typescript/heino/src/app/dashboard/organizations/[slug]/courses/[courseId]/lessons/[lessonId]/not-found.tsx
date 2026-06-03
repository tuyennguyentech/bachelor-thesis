import { NotFoundView } from "@/components/not-found-view"

export default function LessonNotFound() {
  return (
    <NotFoundView
      title="Không tìm thấy bài học"
      description="Bài học này có thể đã bị xoá, được chuyển sang khóa học khác hoặc bạn không còn quyền truy cập."
      scope="lesson"
    />
  )
}
