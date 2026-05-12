"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
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
import { updateLesson, deleteLesson, type ActionState } from "@/app/actions/lessons";

function EditLessonForm({
  id,
  moduleId,
  courseId,
  slug,
  currentTitle,
  currentDescription,
  orderIndex,
  onClose,
}: {
  id: string;
  moduleId: string;
  courseId: string;
  slug: string;
  currentTitle: string;
  currentDescription: string;
  orderIndex: number;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateLesson, undefined);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex flex-col gap-4 pt-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="moduleId" value={moduleId} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="orderIndex" value={orderIndex} />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
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

export function LessonActions({
  id,
  moduleId,
  courseId,
  slug,
  title,
  description,
  orderIndex,
}: {
  id: string;
  moduleId: string;
  courseId: string;
  slug: string;
  title: string;
  description: string;
  orderIndex: number;
}) {
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
                startTransition(async () => { await deleteLesson(id, slug, courseId, moduleId); })
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
