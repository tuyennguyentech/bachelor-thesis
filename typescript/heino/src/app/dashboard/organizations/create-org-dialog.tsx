"use client";

import { useState, useTransition, useRef } from "react";
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
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { ConnectError } from "@connectrpc/connect";
import { PlusIcon } from "lucide-react";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface CreateOrgFormProps {
  token: string;
  userId: string;
  onClose: () => void;
}

function CreateOrgForm({ token, userId, onClose }: CreateOrgFormProps) {
  const router = useRouter();
  const orgClient = useRichterWebClient(OrganizationService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [slug, setSlug] = useState("");
  const slugEdited = useRef(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get("name") as string)?.trim();
    const slugVal = (fd.get("slug") as string)?.trim();

    if (!name || !slugVal) {
      setError("Vui lòng điền đầy đủ thông tin");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        const res = await orgClient.createOrganization({ name, slug: slugVal, createdBy: userId });
        const newSlug = res.organization?.slug ?? slugVal;
        router.push(`/dashboard/organizations/${newSlug}`);
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo tổ chức. Đường dẫn có thể đã tồn tại.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="space-y-1.5">
        <Label htmlFor="org-name">Tên tổ chức</Label>
        <Input
          id="org-name"
          name="name"
          required
          placeholder="Ví dụ: Khoa CNTT HUST"
          onChange={(e) => {
            if (!slugEdited.current) setSlug(slugify(e.target.value));
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="org-slug">Đường dẫn (URL)</Label>
        <Input
          id="org-slug"
          name="slug"
          required
          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
          value={slug}
          onChange={(e) => {
            slugEdited.current = true;
            setSlug(e.target.value);
          }}
          placeholder="vi-du-khoa-cntt"
        />
        <p className="text-xs text-muted-foreground">
          Chỉ dùng chữ thường, số và dấu gạch ngang. Dùng làm URL tổ chức.
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Hủy
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang tạo…" : "Tạo tổ chức"}
        </Button>
      </div>
    </form>
  );
}

interface CreateOrgDialogProps {
  token: string;
  userId: string;
}

export function CreateOrgDialog({ token, userId }: CreateOrgDialogProps) {
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
        </DialogHeader>
        <CreateOrgForm token={token} userId={userId} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
