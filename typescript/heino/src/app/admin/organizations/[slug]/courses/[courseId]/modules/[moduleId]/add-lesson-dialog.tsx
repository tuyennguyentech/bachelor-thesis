"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { useRichterWebClient } from "@/lib/connect-webclient";
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import { ConnectError } from "@connectrpc/connect";
import { PlusIcon } from "lucide-react";

interface AddLessonFormProps {
  moduleId: string;
  courseId: string;
  slug: string;
  nextOrder: number;
  token: string;
  onClose: () => void;
}

function AddLessonForm({ moduleId, courseId: _courseId, slug: _slug, nextOrder, token, onClose }: AddLessonFormProps) {
  const router = useRouter();
  const lessonClient = useRichterWebClient(LessonService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = (fd.get("title") as string)?.trim();
    const description = (fd.get("description") as string)?.trim() ?? "";

    if (!title) { setError("Vui lòng điền đầy đủ thông tin"); return; }

    setError(null);
    startTransition(async () => {
      try {
        await lessonClient.createLesson({ moduleId, title, description, orderIndex: nextOrder });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo bài học");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
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

interface AddLessonDialogProps {
  moduleId: string;
  courseId: string;
  slug: string;
  nextOrder: number;
  token: string;
}

export function AddLessonDialog({ moduleId, courseId, slug, nextOrder, token }: AddLessonDialogProps) {
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
          token={token}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
