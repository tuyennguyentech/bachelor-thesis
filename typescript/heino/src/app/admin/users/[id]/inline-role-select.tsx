"use client";

import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserRole } from "buf/gen/richter/v1/users_pb";
import { updateUserRole } from "@/app/actions/users";

const ROLE_OPTIONS: { label: string; value: UserRole }[] = [
  { label: "Thường",   value: UserRole.NORMAL },
  { label: "Quản trị", value: UserRole.ADMIN },
];

export function InlineRoleSelect({ userId, currentRole }: { userId: string; currentRole: UserRole }) {
  const [, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentRole)}
      onValueChange={(val) => {
        const option = ROLE_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => { await updateUserRole(userId, option.value); });
      }}
    >
      <SelectTrigger className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
