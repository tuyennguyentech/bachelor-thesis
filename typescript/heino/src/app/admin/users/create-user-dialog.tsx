"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createUser, type ActionState } from "@/app/actions/users";
import { UserRole, UserStatus } from "buf/gen/richter/v1/users_pb";
import { PlusIcon } from "lucide-react";

const ROLE_OPTIONS = [
  { label: "Thường",   value: UserRole.NORMAL },
  { label: "Quản trị", value: UserRole.ADMIN },
];

const STATUS_OPTIONS = [
  { label: "Chờ duyệt", value: UserStatus.PENDING },
  { label: "Hoạt động", value: UserStatus.ACTIVE },
  { label: "Vô hiệu",   value: UserStatus.DISABLED },
];

function CreateUserForm({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createUser, undefined);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex flex-col gap-4 pt-2">
      {state?.error && (
        <p className="text-sm text-destructive">{state.error}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Họ</Label>
          <Input id="lastName" name="lastName" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firstName">Tên</Label>
          <Input id="firstName" name="firstName" required />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Mật khẩu</Label>
        <Input id="password" name="password" type="password" required minLength={8} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Vai trò</Label>
          <Select name="role" defaultValue={String(UserRole.NORMAL)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Trạng thái</Label>
          <Select name="status" defaultValue={String(UserStatus.ACTIVE)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Hủy
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang tạo..." : "Tạo"}
        </Button>
      </div>
    </form>
  );
}

export function CreateUserDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Tạo user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo user mới</DialogTitle>
        </DialogHeader>
        <CreateUserForm onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
