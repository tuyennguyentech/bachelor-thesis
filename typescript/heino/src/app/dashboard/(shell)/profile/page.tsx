import { requireAnyUser, displayName } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { notFound } from "next/navigation";
import { EditProfileForm } from "./edit-profile-form";
import { EditPasswordForm } from "./edit-password-form";
import { roleBadge, userStatusBadge } from "@/lib/user-utils";

function initials(first: string, last: string): string {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

export default async function ProfilePage() {
  const { claims, token } = await requireAnyUser();
  const client = createRichterClient(UserService, token);

  let user;
  try {
    const res = await client.getUserById({ id: claims.sub });
    user = res.user;
  } catch {
    notFound();
  }

  if (!user) notFound();

  return (
    <div className="mx-auto max-w-3xl flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Hồ sơ cá nhân</h1>
        <p className="text-sm text-muted-foreground">
          Cập nhật thông tin tài khoản và bảo mật đăng nhập.
        </p>
      </div>

      <div className="flex items-center gap-4 rounded-md border bg-card/40 p-4">
        <Avatar className="size-14">
          <AvatarFallback className="text-lg">{initials(user.firstName, user.lastName)}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-1">
          <p className="font-semibold">{displayName(claims)}</p>
          <p className="text-sm text-muted-foreground">{user.email}</p>
          <div className="flex gap-2">
            {roleBadge(user.role)}
            {userStatusBadge(user.status)}
          </div>
        </div>
      </div>

      <div className="rounded-md border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Thông tin cá nhân</h2>
        <EditProfileForm
          key={`${user.firstName}|${user.middleName ?? ""}|${user.lastName}`}
          userId={claims.sub}
          token={token}
          firstName={user.firstName}
          lastName={user.lastName}
          middleName={user.middleName}
        />
      </div>

      <div className="rounded-md border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Đổi mật khẩu</h2>
        <EditPasswordForm userId={claims.sub} token={token} />
      </div>
    </div>
  );
}
