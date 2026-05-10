"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateOrganization, type ActionState } from "@/app/actions/organizations";

export function EditOrgForm({ orgId, orgSlug, orgName }: { orgId: string; orgSlug: string; orgName: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateOrganization, undefined);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={orgId} />
      <input type="hidden" name="slug" value={orgSlug} />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state?.success && <p className="text-sm text-green-600">Đã lưu</p>}
      <div className="space-y-1.5">
        <Label htmlFor="name">Tên</Label>
        <Input id="name" name="name" defaultValue={orgName} required />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Đang lưu..." : "Lưu"}
        </Button>
      </div>
    </form>
  );
}
