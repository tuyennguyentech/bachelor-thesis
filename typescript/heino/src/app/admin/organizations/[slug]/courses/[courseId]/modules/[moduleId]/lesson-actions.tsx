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
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import { ConnectError } from "@connectrpc/connect";

interface EditLessonFormProps {
  id: string;
  moduleId: string;
  courseId: string;
  slug: string;
  currentTitle: string;
  currentDescription: string;
  orderIndex: number;
  token: string;
  onClose: () => void;
}

function EditLessonForm({ id, moduleId: _moduleId, courseId: _courseId, slug: _slug, currentTitle, currentDescription, orderIndex, token, onClose }: EditLessonFormProps) {
  const router = useRouter();
  const lessonClient = useRichterWebClient(LessonService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = (fd.get("title") as string)?.trim();
    const description = (fd.get("description") as string)?.trim() ?? "";

    if (!title) { setError("Tên không được để trống"); return; }

    setError(null);
    startTransition(async () => {
      try {
        await lessonClient.updateLesson({ id, title, description, orderIndex });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật bài học");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="edit-lesson-title">Tên bài học</Label>
        <Input
          id="edit-lesson-title"
          name="title"
          required
          defaultValue={currentTitle}
          placeholder="VD: Bài 1: Giới thiệu"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="edit-lesson-description">Mô tả</Label>
        <Input
          id="edit-lesson-description"
          name="description"
          defaultValue={currentDescription}
          placeholder="Mô tả ngắn về bài học"
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

interface LessonActionsProps {
  id: string;
  moduleId: string;
  courseId: string;
  slug: string;
  title: string;
  description: string;
  orderIndex: number;
  token: string;
}

export function LessonActions({ id, moduleId, courseId, slug, title, description, orderIndex, token }: LessonActionsProps) {
  const router = useRouter();
  const lessonClient = useRichterWebClient(LessonService, token);
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
          <DropdownMenuItem onSelect={() => setShowEdit(true)}>Chỉnh sửa</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onSelect={() => setShowDelete(true)}>
            Xóa bài học
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chỉnh sửa bài học</DialogTitle>
          </DialogHeader>
          {/* key forces remount on open so defaultValue and error state reset cleanly */}
          <EditLessonForm
            key={showEdit ? "open" : "closed"}
            id={id}
            moduleId={moduleId}
            courseId={courseId}
            slug={slug}
            currentTitle={title}
            currentDescription={description}
            orderIndex={orderIndex}
            token={token}
            onClose={() => setShowEdit(false)}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xóa bài học?</AlertDialogTitle>
            <AlertDialogDescription>
              Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  await lessonClient.deleteLesson({ id });
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
