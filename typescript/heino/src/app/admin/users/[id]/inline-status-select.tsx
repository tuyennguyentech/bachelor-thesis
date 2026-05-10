"use client";

import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserStatus } from "buf/gen/richter/v1/users_pb";
import { updateUserStatus } from "@/app/actions/users";

const STATUS_OPTIONS: { label: string; value: UserStatus }[] = [
  { label: "Chờ duyệt", value: UserStatus.PENDING },
  { label: "Hoạt động", value: UserStatus.ACTIVE },
  { label: "Vô hiệu",   value: UserStatus.DISABLED },
];

export function InlineStatusSelect({ userId, currentStatus }: { userId: string; currentStatus: UserStatus }) {
  const [, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentStatus)}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => { await updateUserStatus(userId, option.value); });
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
