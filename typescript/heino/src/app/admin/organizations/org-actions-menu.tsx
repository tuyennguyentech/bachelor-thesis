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
import { OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";

interface OrgActionsMenuProps {
  orgId: string;
  orgSlug: string;
  orgStatus: OrganizationStatus;
  token: string;
}

export function OrgActionsMenu({ orgId, orgSlug, orgStatus, token }: OrgActionsMenuProps) {
  const router = useRouter();
  const orgClient = useRichterWebClient(OrganizationService, token);
  const [, startTransition] = useTransition();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Mở menu thao tác tổ chức</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/admin/organizations/${orgSlug}`}>Xem chi tiết</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/admin/organizations/${orgSlug}/members`}>Quản lý thành viên</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {orgStatus === OrganizationStatus.ACTIVE ? (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await orgClient.updateOrganizationStatus({ id: orgId, status: OrganizationStatus.SUSPENDED });
                  router.refresh();
                })
              }
            >
              Tạm khóa
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                startTransition(async () => {
                  await orgClient.updateOrganizationStatus({ id: orgId, status: OrganizationStatus.ACTIVE });
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
            <AlertDialogTitle>Xóa tổ chức?</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động này không thể hoàn tác. Tổ chức và toàn bộ dữ liệu liên quan sẽ bị xóa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => startTransition(async () => {
                await orgClient.deleteOrganization({ id: orgId });
                router.push("/admin/organizations");
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
