import { NotFoundView } from "@/components/not-found-view"

export default function AdminNotFound() {
  return (
    <NotFoundView
      title="Không tìm thấy mục quản trị"
      description="Mục quản trị này có thể đã bị xoá, đổi địa chỉ hoặc tài khoản của bạn không còn quyền truy cập."
      scope="admin"
    />
  )
}
