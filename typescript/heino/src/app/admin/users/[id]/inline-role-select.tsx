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
import { UserRole } from "buf/gen/richter/v1/users_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";

const ROLE_OPTIONS: { label: string; value: UserRole }[] = [
  { label: "Thường",   value: UserRole.NORMAL },
  { label: "Quản trị", value: UserRole.ADMIN },
];

interface Props {
  userId: string;
  currentRole: UserRole;
  token: string;
}

export function InlineRoleSelect({ userId, currentRole, token }: Props) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentRole)}
      onValueChange={(val) => {
        const option = ROLE_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => {
          await userClient.updateUserRole({ id: userId, role: option.value });
          router.refresh();
        });
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
