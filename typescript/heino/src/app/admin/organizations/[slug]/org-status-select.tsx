"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";

const STATUS_OPTIONS: { label: string; value: OrganizationStatus }[] = [
  { label: "Hoạt động", value: OrganizationStatus.ACTIVE },
  { label: "Tạm khóa",  value: OrganizationStatus.SUSPENDED },
  { label: "Lưu trữ",   value: OrganizationStatus.ARCHIVED },
];

interface Props {
  orgId: string;
  orgSlug: string;
  currentStatus: OrganizationStatus;
  token: string;
}

export function OrgStatusSelect({ orgId, currentStatus, token }: Props) {
  const router = useRouter();
  const orgClient = useRichterWebClient(OrganizationService, token);
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentStatus)}
      disabled={isPending}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => {
          await orgClient.updateOrganizationStatus({ id: orgId, status: option.value });
          router.refresh();
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
