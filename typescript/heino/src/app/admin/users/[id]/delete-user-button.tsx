"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";

interface Props {
  userId: string;
  token: string;
}

export function DeleteUserButton({ userId, token }: Props) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={pending}>
          Xóa
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xóa user?</AlertDialogTitle>
          <AlertDialogDescription>
            Hành động này không thể hoàn tác. User sẽ bị xóa vĩnh viễn.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => startTransition(async () => {
              await userClient.deleteUser({ id: userId });
              router.push("/admin/users");
            })}
          >
            Xóa
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
