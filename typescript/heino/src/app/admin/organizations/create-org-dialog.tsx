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
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { ConnectError } from "@connectrpc/connect";
import { PlusIcon } from "lucide-react";

interface CreateOrgFormProps {
  token: string;
  onClose: () => void;
}

function CreateOrgForm({ token, onClose }: CreateOrgFormProps) {
  const router = useRouter();
  const orgClient = useRichterWebClient(OrganizationService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get("name") as string)?.trim();
    const slug = (fd.get("slug") as string)?.trim();
    const createdBy = (fd.get("createdBy") as string)?.trim();

    if (!name || !slug || !createdBy) {
      setError("Vui lòng điền đầy đủ thông tin");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        await orgClient.createOrganization({ name, slug, createdBy });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo tổ chức");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
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
        <Label htmlFor="createdBy">Người sở hữu ban đầu</Label>
        <Input id="createdBy" name="createdBy" required placeholder="UUID người dùng" />
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

interface CreateOrgDialogProps {
  token: string;
}

export function CreateOrgDialog({ token }: CreateOrgDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Tạo tổ chức
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo tổ chức mới</DialogTitle>
          <DialogDescription>
            Điền thông tin nhận diện và người sở hữu ban đầu cho tổ chức.
          </DialogDescription>
        </DialogHeader>
        <CreateOrgForm token={token} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
