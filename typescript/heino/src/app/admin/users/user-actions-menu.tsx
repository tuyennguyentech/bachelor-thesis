"use client";

import { useState, useTransition } from "react";
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
import { updateUserStatus, deleteUser } from "@/app/actions/users";

interface UserActionsMenuProps {
  userId: string;
  userStatus: UserStatus;
}

export function UserActionsMenu({ userId, userStatus }: UserActionsMenuProps) {
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
                startTransition(async () => { await updateUserStatus(userId, UserStatus.DISABLED); })
              }
            >
              Vô hiệu hóa
            </DropdownMenuItem>
          ) : isPending ? (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => { await updateUserStatus(userId, UserStatus.ACTIVE); })
              }
            >
              Phê duyệt
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => { await updateUserStatus(userId, UserStatus.ACTIVE); })
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
            <AlertDialogTitle>Xóa user?</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động này không thể hoàn tác. User sẽ bị xóa vĩnh viễn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => startTransition(async () => { await deleteUser(userId); })}
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
