"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateMyPassword, type ActionState } from "@/app/actions/me";

export function EditPasswordForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateMyPassword, undefined);

  return (
    <form action={action} className="flex flex-col gap-3">
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state?.success && <p className="text-sm text-green-600">Đã đổi mật khẩu</p>}
      <div className="space-y-1.5">
        <Label htmlFor="password">Mật khẩu mới</Label>
        <Input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Xác nhận mật khẩu</Label>
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
