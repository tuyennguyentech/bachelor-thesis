"use client";

import { useState, useTransition } from "react";
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
import { toast } from "sonner";

const ROLE_OPTIONS: { label: string; value: UserRole }[] = [
  { label: "Thường",   value: UserRole.NORMAL },
  { label: "Quản trị", value: UserRole.ADMIN },
];

interface Props {
  userId: string;
  currentRole: UserRole;
  token: string;
  disabled?: boolean;
}

export function InlineRoleSelect({ userId, currentRole, token, disabled }: Props) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(String(currentRole));

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(val) => {
        const option = ROLE_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        const previous = value;
        setValue(val);
        startTransition(async () => {
          try {
            await userClient.updateUserRole({ id: userId, role: option.value });
            router.refresh();
          } catch {
            setValue(previous);
            toast.error("Cập nhật vai trò thất bại");
          }
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
