"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { ConnectError } from "@connectrpc/connect";

interface Props {
  userId: string;
  token: string;
}

export function EditPasswordForm({ userId, token }: Props) {
  const userClient = useRichterWebClient(UserService, token);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const oldPassword = (fd.get("oldPassword") as string)?.trim();
    const password = fd.get("password") as string;
    const confirm = fd.get("confirm") as string;

    if (!oldPassword) { setError("Vui lòng nhập mật khẩu hiện tại"); return; }
    if (!password || password.length < 8) { setError("Mật khẩu mới phải có ít nhất 8 ký tự"); return; }
    if (password !== confirm) { setError("Mật khẩu xác nhận không khớp"); return; }

    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await userClient.updateUserPassword({ id: userId, password, oldPassword });
        setSuccess(true);
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể đổi mật khẩu. Kiểm tra lại mật khẩu hiện tại.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">Đã đổi mật khẩu</p>}
      <div className="space-y-1.5">
        <Label htmlFor="oldPassword">Mật khẩu hiện tại</Label>
        <Input id="oldPassword" name="oldPassword" type="password" required autoComplete="current-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Mật khẩu mới</Label>
        <Input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Xác nhận mật khẩu mới</Label>
        <Input id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password" />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Đang đổi..." : "Đổi mật khẩu"}
        </Button>
      </div>
    </form>
  );
}
