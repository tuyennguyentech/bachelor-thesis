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
import { CourseModuleService } from "buf/gen/richter/v1/courses_pb";
import { ConnectError } from "@connectrpc/connect";
import { PlusIcon } from "lucide-react";

interface AddModuleFormProps {
  courseId: string;
  slug: string;
  nextOrder: number;
  token: string;
  onClose: () => void;
}

function AddModuleForm({ courseId, slug: _slug, nextOrder, token, onClose }: AddModuleFormProps) {
  const router = useRouter();
  const moduleClient = useRichterWebClient(CourseModuleService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = (fd.get("title") as string)?.trim();

    if (!title) { setError("Vui lòng điền đầy đủ thông tin"); return; }

    setError(null);
    startTransition(async () => {
      try {
        await moduleClient.createCourseModule({ courseId, title, orderIndex: nextOrder });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo chương");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="title">Tên chương</Label>
        <Input id="title" name="title" required placeholder="VD: Chương 1: Giới thiệu" />
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

interface AddModuleDialogProps {
  courseId: string;
  slug: string;
  nextOrder: number;
  token: string;
}

export function AddModuleDialog({ courseId, slug, nextOrder, token }: AddModuleDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <PlusIcon className="size-4" />
          Thêm chương
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thêm chương mới</DialogTitle>
        </DialogHeader>
        <AddModuleForm
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
