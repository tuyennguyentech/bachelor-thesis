"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/lib/use-hydrated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { ConnectError } from "@connectrpc/connect";

interface Props {
  firstName: string;
  lastName: string;
  middleName?: string;
  userId: string;
  token: string;
}

export function EditProfileForm({ firstName, lastName, middleName, userId, token }: Props) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const firstNameVal = (fd.get("firstName") as string)?.trim();
    const lastNameVal = (fd.get("lastName") as string)?.trim();
    const middleNameVal = (fd.get("middleName") as string)?.trim() || undefined;

    if (!firstNameVal || !lastNameVal) {
      setError("Họ và tên không được để trống");
      return;
    }

    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await userClient.updateUserProfile({ id: userId, firstName: firstNameVal, lastName: lastNameVal, middleName: middleNameVal });
        setSuccess(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật thông tin");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">Đã lưu thay đổi</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Họ</Label>
          <Input id="lastName" name="lastName" defaultValue={lastName} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="middleName">Tên đệm</Label>
          <Input id="middleName" name="middleName" defaultValue={middleName ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firstName">Tên</Label>
          <Input id="firstName" name="firstName" defaultValue={firstName} required />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!hydrated || pending}>
          {pending ? "Đang lưu…" : "Lưu thay đổi"}
        </Button>
      </div>
    </form>
  );
}
