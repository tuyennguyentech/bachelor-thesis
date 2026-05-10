import { Badge } from "@/components/ui/badge";
import { UserRole, UserStatus } from "buf/gen/richter/v1/users_pb";

export function userFullName(user: { firstName: string; middleName?: string; lastName: string }): string {
  return [user.firstName, user.middleName, user.lastName].filter(Boolean).join(" ");
}

export function roleBadge(role: UserRole) {
  return role === UserRole.ADMIN ? (
    <Badge variant="default">Quản trị</Badge>
  ) : (
    <Badge variant="secondary">Thường</Badge>
  );
}

export function userStatusBadge(status: UserStatus) {
  if (status === UserStatus.ACTIVE)
    return <Badge variant="outline" className="border-green-500 text-green-600">Hoạt động</Badge>;
  if (status === UserStatus.PENDING)
    return <Badge variant="outline" className="border-yellow-500 text-yellow-600">Chờ duyệt</Badge>;
  return <Badge variant="destructive">Vô hiệu</Badge>;
}
