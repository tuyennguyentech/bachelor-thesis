"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateCourse, type ActionState } from "@/app/actions/courses";

interface Props {
  courseId: string;
  slug: string;
  title: string;
  description: string;
}

export function EditCourseForm({ courseId, slug, title, description }: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateCourse, undefined);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={courseId} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="slug" value={slug} />
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state?.success && <p className="text-sm text-green-600">Đã lưu</p>}
      <div className="space-y-1.5">
        <Label htmlFor="title">Tên khóa học</Label>
        <Input id="title" name="title" defaultValue={title} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="description">Mô tả</Label>
        <Input id="description" name="description" defaultValue={description} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Đang lưu..." : "Lưu"}
        </Button>
      </div>
    </form>
  );
}
