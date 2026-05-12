"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLesson, type ActionState } from "@/app/actions/lessons";
import { PlusIcon } from "lucide-react";

function AddLessonForm({
  moduleId,
  courseId,
  slug,
  nextOrder,
  onClose,
}: {
  moduleId: string;
  courseId: string;
  slug: string;
  nextOrder: number;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createLesson, undefined);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex flex-col gap-4 pt-2">
      <input type="hidden" name="moduleId" value={moduleId} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="orderIndex" value={nextOrder} />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="lesson-title">Tên bài học</Label>
        <Input id="lesson-title" name="title" required placeholder="VD: Bài 1: Giới thiệu" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lesson-description">Mô tả</Label>
        <Input id="lesson-description" name="description" placeholder="Mô tả ngắn về bài học" />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>Hủy</Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang thêm..." : "Thêm"}
        </Button>
      </div>
    </form>
  );
}

export function AddLessonDialog({
  moduleId,
  courseId,
  slug,
  nextOrder,
}: {
  moduleId: string;
  courseId: string;
  slug: string;
  nextOrder: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <PlusIcon className="size-4" />
          Thêm bài học
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thêm bài học mới</DialogTitle>
        </DialogHeader>
        <AddLessonForm
          moduleId={moduleId}
          courseId={courseId}
          slug={slug}
          nextOrder={nextOrder}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
