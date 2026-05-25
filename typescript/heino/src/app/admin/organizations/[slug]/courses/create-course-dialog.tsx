"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { CourseService } from "buf/gen/richter/v1/courses_pb";
import { ConnectError } from "@connectrpc/connect";
import { PlusIcon } from "lucide-react";

interface CreateCourseFormProps {
  organizationId: string;
  slug: string;
  token: string;
  userId: string;
  onClose: () => void;
}

function CreateCourseForm({ organizationId, token, userId, onClose }: CreateCourseFormProps) {
  const router = useRouter();
  const courseClient = useRichterWebClient(CourseService, token);
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
        await courseClient.createCourse({ organizationId, ownerId: userId, title, description });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo khóa học");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
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
          {pending ? "Đang tạo…" : "Tạo"}
        </Button>
      </div>
    </form>
  );
}

interface CreateCourseDialogProps {
  organizationId: string;
  slug: string;
  token: string;
  userId: string;
}

export function CreateCourseDialog({ organizationId, slug, token, userId }: CreateCourseDialogProps) {
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
          <DialogDescription>
            Khóa học mới sẽ được tạo trong tổ chức hiện tại và có thể thêm chương sau khi lưu.
          </DialogDescription>
        </DialogHeader>
        <CreateCourseForm organizationId={organizationId} slug={slug} token={token} userId={userId} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
