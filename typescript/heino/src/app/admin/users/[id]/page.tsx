import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { DeleteUserButton } from "./delete-user-button";
import { InlineStatusSelect } from "./inline-status-select";
import { InlineRoleSelect } from "./inline-role-select";
import { EditProfileForm } from "./edit-profile-form";
import { EditPasswordForm } from "./edit-password-form";
import { notFound } from "next/navigation";
import { userFullName } from "@/lib/user-utils";

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { token } = await requireAdmin();
  const { id } = await params;

  const client = createRichterClient(UserService, token);

  let user;
  try {
    const res = await client.getUserById({ id });
    user = res.user;
  } catch {
    notFound();
  }

  if (!user) notFound();

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href="/admin/users">
            <ChevronLeftIcon className="size-4" />
            Người dùng
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-xl font-semibold">
          {userFullName(user)}
        </h1>
        <p className="text-sm text-muted-foreground">{user.email}</p>
      </div>

      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Thông tin cá nhân</h2>
        <EditProfileForm
          userId={user.id}
          firstName={user.firstName}
          lastName={user.lastName}
          middleName={user.middleName}
        />
      </div>

      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Tài khoản</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Email</p>
            <p className="text-sm font-medium">{user.email}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Ngày tạo</p>
            <p className="text-sm">
              {user.createdAt
                ? new Date(Number(user.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                : "—"}
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">Vai trò</p>
            <InlineRoleSelect userId={user.id} currentRole={user.role} />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">Trạng thái</p>
            <InlineStatusSelect userId={user.id} currentStatus={user.status} />
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Đổi mật khẩu</h2>
        <EditPasswordForm userId={user.id} />
      </div>

      <div className="rounded-lg border border-destructive/30 p-4 flex items-center justify-between">
        <div>
          <p className="font-medium text-sm">Xóa user</p>
          <p className="text-xs text-muted-foreground">Hành động này không thể hoàn tác</p>
        </div>
        <DeleteUserButton userId={user.id} />
      </div>
    </div>
  );
}
