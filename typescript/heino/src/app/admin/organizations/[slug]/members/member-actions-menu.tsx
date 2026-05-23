"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { useRichterWebClient } from "@/lib/connect-webclient";
import { OrganizationMemberService } from "buf/gen/richter/v1/organization_members_pb";
import { ConnectError } from "@connectrpc/connect";

interface MemberActionsMenuProps {
  organizationId: string;
  userId: string;
  currentRole: OrganizationRole;
  currentStatus: MemberStatus;
  slug: string;
  token: string;
}

export function MemberActionsMenu({
  organizationId,
  userId,
  currentRole,
  currentStatus,
  token,
}: MemberActionsMenuProps) {
  const router = useRouter();
  const memberClient = useRichterWebClient(OrganizationMemberService, token);
  const [isPending, startTransition] = useTransition();
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      {error && <p className="text-xs text-destructive max-w-48 text-right">{error}</p>}
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
                  disabled={value === currentRole || isPending}
                  onClick={() =>
                    startTransition(async () => {
                      setError(null);
                      try {
                        await memberClient.updateOrganizationMemberRole({ organizationId, userId, role: value });
                        router.refresh();
                      } catch (err) {
                        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật vai trò");
                      }
                    })
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
                  disabled={value === currentStatus || isPending}
                  onClick={() =>
                    startTransition(async () => {
                      setError(null);
                      try {
                        await memberClient.updateOrganizationMemberStatus({ organizationId, userId, status: value });
                        router.refresh();
                      } catch (err) {
                        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật trạng thái");
                      }
                    })
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
                startTransition(async () => {
                  setError(null);
                  try {
                    await memberClient.removeOrganizationMember({ organizationId, userId });
                    router.refresh();
                  } catch (err) {
                    setError(err instanceof ConnectError ? err.message : "Không thể xóa thành viên");
                  }
                })
              }
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
