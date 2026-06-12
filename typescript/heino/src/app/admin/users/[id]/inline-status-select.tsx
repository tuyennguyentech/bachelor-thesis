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
import { UserStatus } from "buf/gen/richter/v1/users_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { toast } from "sonner";

const STATUS_OPTIONS: { label: string; value: UserStatus }[] = [
  { label: "Chờ duyệt", value: UserStatus.PENDING },
  { label: "Hoạt động", value: UserStatus.ACTIVE },
  { label: "Vô hiệu",   value: UserStatus.DISABLED },
];

interface Props {
  userId: string;
  currentStatus: UserStatus;
  token: string;
  disabled?: boolean;
}

export function InlineStatusSelect({ userId, currentStatus, token, disabled }: Props) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(String(currentStatus));

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        const previous = value;
        setValue(val);
        startTransition(async () => {
          try {
            await userClient.updateUserStatus({ id: userId, status: option.value });
            router.refresh();
          } catch {
            setValue(previous);
            toast.error("Cập nhật trạng thái thất bại");
          }
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
