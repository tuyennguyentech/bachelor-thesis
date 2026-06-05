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
import { PageHeader } from "@/components/ui/page-header";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { claims, token } = await requireAdmin();
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
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: `admin-user:${user.id}`,
          type: "admin-user",
          area: "admin",
          title: userFullName(user),
          subtitle: user.email,
          href: `/admin/users/${user.id}`,
        }}
      />

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href="/admin/users">
            <ChevronLeftIcon className="size-4" />
            Người dùng
          </Link>
        </Button>
      </div>

      <PageHeader title={userFullName(user)} description={user.email} />

      <div className="rounded-md border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Thông tin cá nhân</h2>
        <EditProfileForm
          userId={user.id}
          token={token}
          firstName={user.firstName}
          lastName={user.lastName}
          middleName={user.middleName}
        />
      </div>

      <div className="rounded-md border p-4 flex flex-col gap-4">
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
            <InlineRoleSelect userId={user.id} currentRole={user.role} token={token} />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">Trạng thái</p>
            <InlineStatusSelect userId={user.id} currentStatus={user.status} token={token} />
          </div>
        </div>
      </div>

      <div className="rounded-md border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Đổi mật khẩu</h2>
        <EditPasswordForm userId={user.id} token={token} />
      </div>

      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 flex items-center justify-between">
        <div>
          <p className="font-medium text-sm">Xóa người dùng</p>
          <p className="text-xs text-muted-foreground">Hành động này không thể hoàn tác</p>
        </div>
        <DeleteUserButton userId={user.id} token={token} />
      </div>
    </div>
  );
}
