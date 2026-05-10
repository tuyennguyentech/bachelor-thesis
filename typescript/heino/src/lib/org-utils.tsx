import { Badge } from "@/components/ui/badge";
import { OrganizationRole, MemberStatus } from "buf/gen/richter/v1/organization_members_pb";
import { OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";

export function roleName(role: OrganizationRole): string {
  switch (role) {
    case OrganizationRole.OWNER:   return "Chủ sở hữu";
    case OrganizationRole.ADMIN:   return "Quản trị viên";
    case OrganizationRole.TEACHER: return "Giảng viên";
    case OrganizationRole.STUDENT: return "Học viên";
    default:                       return "Không xác định";
  }
}

export function memberStatusBadge(status: MemberStatus) {
  if (status === MemberStatus.ACTIVE)
    return <Badge variant="outline" className="border-green-500 text-green-600">Hoạt động</Badge>;
  if (status === MemberStatus.INVITED)
    return <Badge variant="outline" className="border-yellow-500 text-yellow-600">Đã mời</Badge>;
  return <Badge variant="outline" className="border-red-400 text-red-500">Tạm khóa</Badge>;
}

export function orgStatusBadge(status: OrganizationStatus) {
  if (status === OrganizationStatus.ACTIVE)
    return <Badge variant="outline" className="border-green-500 text-green-600">Hoạt động</Badge>;
  if (status === OrganizationStatus.SUSPENDED)
    return <Badge variant="outline" className="border-yellow-500 text-yellow-600">Tạm khóa</Badge>;
  return <Badge variant="secondary">Lưu trữ</Badge>;
}
