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
import { createOrganization, type ActionState } from "@/app/actions/organizations";
import { PlusIcon } from "lucide-react";

function CreateOrgForm({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createOrganization,
    undefined,
  );

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex flex-col gap-4 pt-2">
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="name">Tên</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" name="slug" required pattern="[a-z0-9-]+" />
        <p className="text-xs text-muted-foreground">Chỉ dùng chữ thường, số và dấu gạch ngang</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="createdBy">Owner (User ID)</Label>
        <Input id="createdBy" name="createdBy" required placeholder="uuid của user" />
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

export function CreateOrgDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Tạo organization
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo organization mới</DialogTitle>
        </DialogHeader>
        <CreateOrgForm onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
