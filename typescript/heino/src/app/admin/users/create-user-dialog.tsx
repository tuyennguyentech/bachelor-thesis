"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService, UserRole, UserStatus } from "buf/gen/richter/v1/users_pb";
import { ConnectError } from "@connectrpc/connect";
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

interface CreateUserFormProps {
  token: string;
  onClose: () => void;
}

function CreateUserForm({ token, onClose }: CreateUserFormProps) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [selectedRole, setSelectedRole] = useState(String(UserRole.NORMAL));
  const [selectedStatus, setSelectedStatus] = useState(String(UserStatus.ACTIVE));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = (fd.get("email") as string)?.trim();
    const password = fd.get("password") as string;
    const firstName = (fd.get("firstName") as string)?.trim();
    const lastName = (fd.get("lastName") as string)?.trim();
    const role = parseInt(selectedRole) as UserRole;
    const status = parseInt(selectedStatus) as UserStatus;

    if (!email || !password || !firstName || !lastName) {
      setError("Vui lòng điền đầy đủ thông tin");
      return;
    }
    if (isNaN(role) || isNaN(status)) {
      setError("Vai trò hoặc trạng thái không hợp lệ");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        await userClient.createUserWithRoleAndStatus({ email, password, firstName, lastName, role, status });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo người dùng");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && (
        <p className="text-sm text-destructive">{error}</p>
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
          <Select value={selectedRole} onValueChange={setSelectedRole}>
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
          <Select value={selectedStatus} onValueChange={setSelectedStatus}>
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
          {pending ? "Đang tạo…" : "Tạo"}
        </Button>
      </div>
    </form>
  );
}

interface CreateUserDialogProps {
  token: string;
}

export function CreateUserDialog({ token }: CreateUserDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Tạo người dùng
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo người dùng mới</DialogTitle>
          <DialogDescription>
            Tạo tài khoản và gán vai trò truy cập hệ thống.
          </DialogDescription>
        </DialogHeader>
        <CreateUserForm token={token} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
