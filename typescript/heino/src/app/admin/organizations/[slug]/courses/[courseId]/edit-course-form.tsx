"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/lib/use-hydrated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { CourseService } from "buf/gen/richter/v1/courses_pb";
import { ConnectError } from "@connectrpc/connect";

interface Props {
  courseId: string;
  slug: string;
  title: string;
  description: string;
  token: string;
}

export function EditCourseForm({ courseId, title, description, token }: Props) {
  const router = useRouter();
  const courseClient = useRichterWebClient(CourseService, token);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const titleVal = (fd.get("title") as string)?.trim();
    const descriptionVal = (fd.get("description") as string)?.trim() ?? "";

    if (!titleVal) { setError("Tên không được để trống"); return; }

    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await courseClient.updateCourse({ id: courseId, title: titleVal, description: descriptionVal });
        setSuccess(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể cập nhật khóa học");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">Đã lưu</p>}
      <div className="space-y-1.5">
        <Label htmlFor="title">Tên khóa học</Label>
        <Input id="title" name="title" defaultValue={title} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="description">Mô tả</Label>
        <Input id="description" name="description" defaultValue={description} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!hydrated || pending}>
          {pending ? "Đang lưu…" : "Lưu"}
        </Button>
      </div>
    </form>
  );
}
