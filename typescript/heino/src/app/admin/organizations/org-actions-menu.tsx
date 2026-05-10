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
import { OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";
import { updateOrganizationStatus, deleteOrganization } from "@/app/actions/organizations";

interface OrgActionsMenuProps {
  orgId: string;
  orgSlug: string;
  orgStatus: OrganizationStatus;
}

export function OrgActionsMenu({ orgId, orgSlug, orgStatus }: OrgActionsMenuProps) {
  const [, startTransition] = useTransition();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
            <Link href={`/admin/organizations/${orgSlug}`}>Xem chi tiết</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/admin/organizations/${orgSlug}/members`}>Quản lý members</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {orgStatus === OrganizationStatus.ACTIVE ? (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await updateOrganizationStatus(orgId, orgSlug, OrganizationStatus.SUSPENDED);
                })
              }
            >
              Tạm khóa
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await updateOrganizationStatus(orgId, orgSlug, OrganizationStatus.ACTIVE);
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
            <AlertDialogTitle>Xóa organization?</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động này không thể hoàn tác. Organization và toàn bộ dữ liệu liên quan sẽ bị xóa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => startTransition(async () => { await deleteOrganization(orgId); })}
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
