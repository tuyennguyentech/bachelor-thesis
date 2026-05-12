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
import { addMember, type ActionState } from "@/app/actions/members";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { PlusIcon } from "lucide-react";

const ROLE_OPTIONS = [
  { label: "Chủ sở hữu", value: OrganizationRole.OWNER },
  { label: "Quản trị",   value: OrganizationRole.ADMIN },
  { label: "Giảng viên", value: OrganizationRole.TEACHER },
  { label: "Học viên",   value: OrganizationRole.STUDENT },
];

function AddMemberForm({
  organizationId,
  slug,
  onClose,
}: {
  organizationId: string;
  slug: string;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addMember, undefined);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex flex-col gap-4 pt-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="slug" value={slug} />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required placeholder="user@example.com" />
      </div>
      <div className="space-y-1.5">
        <Label>Vai trò</Label>
        <Select name="role" defaultValue={String(OrganizationRole.STUDENT)}>
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

export function AddMemberDialog({ organizationId, slug }: { organizationId: string; slug: string }) {
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
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
