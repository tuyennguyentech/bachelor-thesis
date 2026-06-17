"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { respondToOrgInvitationAction } from "@/app/actions/organization-members";

/**
 * Accept / decline buttons for a pending organization invitation. Accepting
 * navigates into the org; declining (an irreversible action — the user would
 * need to be re-invited) is gated behind a confirmation dialog.
 */
export function OrgInvitationActions({
  orgId,
  slug,
  orgName,
}: {
  orgId: string;
  slug?: string;
  orgName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [which, setWhich] = useState<"accept" | "decline" | null>(null);

  function respond(accept: boolean) {
    setWhich(accept ? "accept" : "decline");
    startTransition(async () => {
      const res = await respondToOrgInvitationAction(orgId, accept);
      if ("error" in res && res.error) {
        toast.error(res.error);
        setWhich(null);
        return;
      }
      if (accept) {
        toast.success("Đã tham gia tổ chức");
        if (slug) router.push(`/dashboard/organizations/${slug}`);
        else router.refresh();
      } else {
        toast.success("Đã từ chối lời mời");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        className="h-8 flex-1 gap-1 text-xs"
        onClick={() => respond(true)}
        disabled={pending}
        data-testid="invite-accept"
      >
        <CheckIcon className="size-3.5" />
        {pending && which === "accept" ? "Đang tham gia…" : "Chấp nhận"}
      </Button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs text-muted-foreground hover:border-destructive/40 hover:text-destructive"
            disabled={pending}
            data-testid="invite-decline"
          >
            <XIcon className="size-3.5" />
            Từ chối
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Từ chối lời mời?</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn sẽ rời khỏi lời mời tham gia{" "}
              <span className="font-medium text-foreground">{orgName}</span> và cần được quản trị
              viên mời lại nếu đổi ý.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => respond(false)}
              data-testid="invite-decline-confirm"
            >
              Từ chối lời mời
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
