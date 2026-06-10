"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { CourseMemberService } from "buf/gen/richter/v1/course_members_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { toUserMessage } from "@/lib/connect-error";

interface CourseMemberActionsMenuProps {
  courseId: string;
  userId: string;
  displayName: string;
  token: string;
}

export function CourseMemberActionsMenu({
  courseId,
  userId,
  displayName,
  token,
}: CourseMemberActionsMenuProps) {
  const router = useRouter();
  const memberClient = useRichterWebClient(CourseMemberService, token);
  const [isPending, startTransition] = useTransition();
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      {error && <p className="text-xs text-destructive max-w-48 text-right">{error}</p>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" disabled={isPending}>
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Mở menu thao tác thành viên</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => setShowRemoveConfirm(true)}
          >
            Xóa khỏi khóa học
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showRemoveConfirm} onOpenChange={setShowRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa thành viên?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{displayName}</strong> sẽ bị xóa khỏi khóa học. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  try {
                    await memberClient.removeCourseMember({ courseId, userId });
                    router.refresh();
                  } catch (err) {
                    setError(toUserMessage(err, "Không thể xóa thành viên"));
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
