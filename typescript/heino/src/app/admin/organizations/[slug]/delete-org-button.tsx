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
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";

interface Props {
  orgId: string;
  token: string;
}

export function DeleteOrgButton({ orgId, token }: Props) {
  const router = useRouter();
  const orgClient = useRichterWebClient(OrganizationService, token);
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
          <AlertDialogTitle>Xóa organization?</AlertDialogTitle>
          <AlertDialogDescription>
            Hành động này không thể hoàn tác. Organization và toàn bộ dữ liệu liên quan sẽ bị xóa.
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
  );
}
