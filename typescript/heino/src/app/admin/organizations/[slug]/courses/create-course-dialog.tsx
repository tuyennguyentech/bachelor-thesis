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
import { createCourse, type ActionState } from "@/app/actions/courses";
import { PlusIcon } from "lucide-react";

function CreateCourseForm({
  organizationId,
  slug,
  onClose,
}: {
  organizationId: string;
  slug: string;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createCourse, undefined);

  useEffect(() => {
    if (state?.success) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex flex-col gap-4 pt-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="slug" value={slug} />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="title">Tên khóa học</Label>
        <Input id="title" name="title" required placeholder="VD: Lập trình Python cơ bản" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="description">Mô tả</Label>
        <Input id="description" name="description" placeholder="Mô tả ngắn về khóa học" />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>Hủy</Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang tạo..." : "Tạo"}
        </Button>
      </div>
    </form>
  );
}

export function CreateCourseDialog({ organizationId, slug }: { organizationId: string; slug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Tạo khóa học
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo khóa học mới</DialogTitle>
        </DialogHeader>
        <CreateCourseForm organizationId={organizationId} slug={slug} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
