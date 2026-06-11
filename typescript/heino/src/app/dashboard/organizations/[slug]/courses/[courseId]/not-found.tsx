import { NotFoundView } from "@/components/not-found-view"

export default function CourseNotFound() {
  return (
    <NotFoundView
      title="Không tìm thấy khóa học"
      description="Khóa học này có thể đã bị xoá, chuyển sang tổ chức khác hoặc bạn không còn quyền truy cập."
      scope="course"
    />
  )
}
