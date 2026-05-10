"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateMyProfile, type ActionState } from "@/app/actions/me";

interface Props {
  firstName: string;
  lastName: string;
  middleName?: string;
}

export function EditProfileForm({ firstName, lastName, middleName }: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateMyProfile, undefined);

  return (
    <form action={action} className="flex flex-col gap-3">
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state?.success && <p className="text-sm text-green-600">Đã lưu thay đổi</p>}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Họ</Label>
          <Input id="lastName" name="lastName" defaultValue={lastName} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firstName">Tên</Label>
          <Input id="firstName" name="firstName" defaultValue={firstName} required />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="middleName">Tên đệm</Label>
        <Input id="middleName" name="middleName" defaultValue={middleName ?? ""} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Đang lưu..." : "Lưu thay đổi"}
        </Button>
      </div>
    </form>
  );
}
