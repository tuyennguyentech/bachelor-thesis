"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/lib/use-hydrated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { ConnectError } from "@connectrpc/connect";

interface Props {
  orgId: string;
  orgSlug: string;
  orgName: string;
  token: string;
}

export function EditOrgForm({ orgId, orgSlug, orgName, token }: Props) {
  const router = useRouter();
  const orgClient = useRichterWebClient(OrganizationService, token);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = (fd.get("name") as string)?.trim();

    if (!name) { setError("Tên không được để trống"); return; }

    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await orgClient.updateOrganization({ id: orgId, name, slug: orgSlug });
        setSuccess(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật tổ chức");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">Đã lưu</p>}
      <div className="space-y-1.5">
        <Label htmlFor="name">Tên</Label>
        <Input id="name" name="name" defaultValue={orgName} required />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!hydrated || pending}>
          {pending ? "Đang lưu…" : "Lưu"}
        </Button>
      </div>
    </form>
  );
}
