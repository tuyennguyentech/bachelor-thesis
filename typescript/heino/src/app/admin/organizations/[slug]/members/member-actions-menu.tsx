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
import { toast } from "sonner";
import { toUserMessage } from "@/lib/connect-error";

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Mở menu thao tác thành viên</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Đổi vai trò</DropdownMenuSubTrigger>
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
                      try {
                        await memberClient.updateOrganizationMemberRole({ organizationId, userId, role: value });
                        toast.success("Đã cập nhật vai trò thành viên");
                        router.refresh();
                      } catch (err) {
                        toast.error(toUserMessage(err, "Không thể cập nhật vai trò"));
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
                { label: "Hoạt động",     value: MemberStatus.ACTIVE },
                { label: "Chờ chấp nhận", value: MemberStatus.INVITED },
                { label: "Tạm khóa",      value: MemberStatus.SUSPENDED },
              ].map(({ label, value }) => (
                <DropdownMenuItem
                  key={value}
                  disabled={value === currentStatus || isPending}
                  onClick={() =>
                    startTransition(async () => {
                      try {
                        await memberClient.updateOrganizationMemberStatus({ organizationId, userId, status: value });
                        toast.success("Đã cập nhật trạng thái thành viên");
                        router.refresh();
                      } catch (err) {
                        toast.error(toUserMessage(err, "Không thể cập nhật trạng thái"));
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
            Xóa khỏi tổ chức
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
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await memberClient.removeOrganizationMember({ organizationId, userId });
                    toast.success("Đã xóa thành viên khỏi tổ chức");
                    router.refresh();
                  } catch (err) {
                    toast.error(toUserMessage(err, "Không thể xóa thành viên"));
                  }
                })
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
