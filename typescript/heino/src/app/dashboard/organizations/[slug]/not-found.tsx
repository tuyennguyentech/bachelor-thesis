import { NotFoundView } from "@/components/not-found-view"

export default function OrganizationNotFound() {
  return (
    <NotFoundView
      title="Không tìm thấy tổ chức"
      description="Tổ chức này có thể đã bị xoá, đổi slug hoặc tài khoản của bạn không còn quyền truy cập."
      scope="organization"
    />
  )
}
