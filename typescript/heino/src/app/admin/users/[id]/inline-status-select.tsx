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
import { UserStatus } from "buf/gen/richter/v1/users_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";

const STATUS_OPTIONS: { label: string; value: UserStatus }[] = [
  { label: "Chờ duyệt", value: UserStatus.PENDING },
  { label: "Hoạt động", value: UserStatus.ACTIVE },
  { label: "Vô hiệu",   value: UserStatus.DISABLED },
];

interface Props {
  userId: string;
  currentStatus: UserStatus;
  token: string;
}

export function InlineStatusSelect({ userId, currentStatus, token }: Props) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentStatus)}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => {
          await userClient.updateUserStatus({ id: userId, status: option.value });
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
