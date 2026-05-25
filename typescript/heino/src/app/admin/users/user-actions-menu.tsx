"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { MoreHorizontalIcon } from "lucide-react";
import { UserStatus } from "buf/gen/richter/v1/users_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UserService } from "buf/gen/richter/v1/users_pb";

interface UserActionsMenuProps {
  userId: string;
  userStatus: UserStatus;
  token: string;
}

export function UserActionsMenu({ userId, userStatus, token }: UserActionsMenuProps) {
  const router = useRouter();
  const userClient = useRichterWebClient(UserService, token);
  const [, startTransition] = useTransition();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isActive = userStatus === UserStatus.ACTIVE;
  const isPending = userStatus === UserStatus.PENDING;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Mở menu thao tác người dùng</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/admin/users/${userId}`}>Xem chi tiết</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isActive ? (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await userClient.updateUserStatus({ id: userId, status: UserStatus.DISABLED });
                  router.refresh();
                })
              }
            >
              Vô hiệu hóa
            </DropdownMenuItem>
          ) : isPending ? (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await userClient.updateUserStatus({ id: userId, status: UserStatus.ACTIVE });
                  router.refresh();
                })
              }
            >
              Phê duyệt
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await userClient.updateUserStatus({ id: userId, status: UserStatus.ACTIVE });
                  router.refresh();
                })
              }
            >
              Kích hoạt
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => setShowDeleteConfirm(true)}
          >
            Xóa
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa người dùng?</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động này không thể hoàn tác. Người dùng sẽ bị xóa vĩnh viễn.
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
    </>
  );
}
