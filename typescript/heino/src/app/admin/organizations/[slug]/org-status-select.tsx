"use client";

import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";
import { updateOrganizationStatus } from "@/app/actions/organizations";

const STATUS_OPTIONS: { label: string; value: OrganizationStatus }[] = [
  { label: "Hoạt động", value: OrganizationStatus.ACTIVE },
  { label: "Tạm khóa",  value: OrganizationStatus.SUSPENDED },
  { label: "Lưu trữ",   value: OrganizationStatus.ARCHIVED },
];

export function OrgStatusSelect({
  orgId,
  orgSlug,
  currentStatus,
}: {
  orgId: string;
  orgSlug: string;
  currentStatus: OrganizationStatus;
}) {
  const [, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentStatus)}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => {
          await updateOrganizationStatus(orgId, orgSlug, option.value);
        });
      }}
    >
      <SelectTrigger className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
