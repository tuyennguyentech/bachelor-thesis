"use client";

import { useState, useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { OrganizationRole, MemberStatus } from "buf/gen/richter/v1/organization_members_pb";
import { updateMemberRole, updateMemberStatus, removeMember } from "@/app/actions/members";

interface MemberActionsMenuProps {
  organizationId: string;
  userId: string;
  currentRole: OrganizationRole;
  currentStatus: MemberStatus;
  slug: string;
}

export function MemberActionsMenu({
  organizationId,
  userId,
  currentRole,
  currentStatus,
  slug,
}: MemberActionsMenuProps) {
  const [, startTransition] = useTransition();
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Đổi role</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {[
                { label: "Chủ sở hữu", value: OrganizationRole.OWNER },
                { label: "Quản trị",   value: OrganizationRole.ADMIN },
                { label: "Giảng viên", value: OrganizationRole.TEACHER },
                { label: "Học viên",   value: OrganizationRole.STUDENT },
              ].map(({ label, value }) => (
                <DropdownMenuItem
                  key={value}
                  disabled={value === currentRole}
                  onClick={() =>
                    startTransition(async () => { await updateMemberRole(organizationId, userId, value, slug) })
                  }
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Đổi trạng thái</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {[
                { label: "Hoạt động", value: MemberStatus.ACTIVE },
                { label: "Đã mời",   value: MemberStatus.INVITED },
                { label: "Tạm khóa", value: MemberStatus.SUSPENDED },
              ].map(({ label, value }) => (
                <DropdownMenuItem
                  key={value}
                  disabled={value === currentStatus}
                  onClick={() =>
                    startTransition(async () => { await updateMemberStatus(organizationId, userId, value, slug) })
                  }
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => setShowRemoveConfirm(true)}
          >
            Xóa khỏi org
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showRemoveConfirm} onOpenChange={setShowRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa thành viên?</AlertDialogTitle>
            <AlertDialogDescription>
              Thành viên sẽ bị xóa khỏi tổ chức. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                startTransition(async () => { await removeMember(organizationId, userId, slug) })
              }
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
