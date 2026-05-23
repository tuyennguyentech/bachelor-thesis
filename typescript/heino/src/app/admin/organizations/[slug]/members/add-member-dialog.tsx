"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationMemberService, OrganizationRole, MemberStatus } from "buf/gen/richter/v1/organization_members_pb";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { ConnectError } from "@connectrpc/connect";
import { PlusIcon } from "lucide-react";

const ROLE_OPTIONS = [
  { label: "Chủ sở hữu", value: OrganizationRole.OWNER },
  { label: "Quản trị",   value: OrganizationRole.ADMIN },
  { label: "Giảng viên", value: OrganizationRole.TEACHER },
  { label: "Học viên",   value: OrganizationRole.STUDENT },
];

interface AddMemberFormProps {
  organizationId: string;
  slug: string;
  token: string;
  onClose: () => void;
}

function AddMemberForm({ organizationId, token, onClose }: AddMemberFormProps) {
  const router = useRouter();
  const memberClient = useRichterWebClient(OrganizationMemberService, token);
  const userClient = useRichterWebClient(UserService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [selectedRole, setSelectedRole] = useState(String(OrganizationRole.STUDENT));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = (fd.get("email") as string)?.trim();
    const role = parseInt(selectedRole) as OrganizationRole;

    if (!email) { setError("Vui lòng điền đầy đủ thông tin"); return; }
    if (isNaN(role)) { setError("Vai trò không hợp lệ"); return; }

    setError(null);
    startTransition(async () => {
      try {
        const userRes = await userClient.getUserByEmail({ email });
        if (!userRes.user) { setError("Không tìm thấy người dùng với email này"); return; }
        await memberClient.addOrganizationMember({ organizationId, userId: userRes.user.id, role, status: MemberStatus.ACTIVE });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể thêm thành viên");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required placeholder="user@example.com" />
      </div>
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
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Hủy
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang thêm..." : "Thêm"}
        </Button>
      </div>
    </form>
  );
}

interface AddMemberDialogProps {
  organizationId: string;
  slug: string;
  token: string;
}

export function AddMemberDialog({ organizationId, slug, token }: AddMemberDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Thêm thành viên
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thêm thành viên</DialogTitle>
        </DialogHeader>
        <AddMemberForm
          organizationId={organizationId}
          slug={slug}
          token={token}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
