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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoreHorizontalIcon } from "lucide-react";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { CourseModuleService } from "buf/gen/richter/v1/courses_pb";
import { ConnectError } from "@connectrpc/connect";

interface EditModuleFormProps {
  id: string;
  courseId: string;
  slug: string;
  currentTitle: string;
  orderIndex: number;
  token: string;
  onClose: () => void;
}

function EditModuleForm({ id, courseId: _courseId, slug: _slug, currentTitle, orderIndex, token, onClose }: EditModuleFormProps) {
  const router = useRouter();
  const moduleClient = useRichterWebClient(CourseModuleService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = (fd.get("title") as string)?.trim();

    if (!title) { setError("Tên không được để trống"); return; }

    setError(null);
    startTransition(async () => {
      try {
        await moduleClient.updateCourseModule({ id, title, orderIndex });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật chương");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="edit-module-title">Tên chương</Label>
        <Input
          id="edit-module-title"
          name="title"
          required
          defaultValue={currentTitle}
          placeholder="VD: Chương 1: Giới thiệu"
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>Hủy</Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang lưu..." : "Lưu"}
        </Button>
      </div>
    </form>
  );
}

interface ModuleActionsProps {
  id: string;
  courseId: string;
  slug: string;
  title: string;
  orderIndex: number;
  token: string;
}

export function ModuleActions({ id, courseId, slug, title, orderIndex, token }: ModuleActionsProps) {
  const router = useRouter();
  const moduleClient = useRichterWebClient(CourseModuleService, token);
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setShowEdit(true)}>Đổi tên</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={() => setShowDelete(true)}>
            Xóa chương
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Đổi tên chương</DialogTitle>
          </DialogHeader>
          {/* key forces remount on open so defaultValue and error state reset cleanly */}
          <EditModuleForm
            key={showEdit ? "open" : "closed"}
            id={id}
            courseId={courseId}
            slug={slug}
            currentTitle={title}
            orderIndex={orderIndex}
            token={token}
            onClose={() => setShowEdit(false)}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa chương?</AlertDialogTitle>
            <AlertDialogDescription>
              Toàn bộ bài học trong chương sẽ bị xóa. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  await moduleClient.deleteCourseModule({ id });
                  router.refresh();
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
