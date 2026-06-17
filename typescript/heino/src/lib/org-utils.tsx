import { Badge } from "@/components/ui/badge";
import { CheckCircle2Icon, ClockIcon, BanIcon } from "lucide-react";
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
  // Filled tonal badges + a leading icon so status is conveyed by shape, not
  // colour alone (accessibility), and is scannable in member tables.
  if (status === MemberStatus.ACTIVE)
    return (
      <Badge variant="outline" className="gap-1 border-green-200 bg-green-100 text-green-800 dark:border-green-900/50 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle2Icon className="size-3" /> Hoạt động
      </Badge>
    );
  if (status === MemberStatus.INVITED)
    return (
      <Badge variant="outline" className="gap-1 border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/30 dark:text-amber-400">
        <ClockIcon className="size-3" /> Chờ chấp nhận
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1 border-red-200 bg-red-100 text-red-700 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400">
      <BanIcon className="size-3" /> Tạm khóa
    </Badge>
  );
}

export function orgStatusBadge(status: OrganizationStatus) {
  if (status === OrganizationStatus.ACTIVE)
    return <Badge variant="outline" className="border-green-500 text-green-600">Hoạt động</Badge>;
  if (status === OrganizationStatus.SUSPENDED)
    return <Badge variant="outline" className="border-yellow-500 text-yellow-600">Tạm khóa</Badge>;
  return <Badge variant="secondary">Lưu trữ</Badge>;
}
