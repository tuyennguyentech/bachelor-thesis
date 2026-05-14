"use client";

import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CourseStatus } from "buf/gen/richter/v1/courses_pb";
import { updateCourseStatus } from "@/app/actions/courses";

const STATUS_OPTIONS: { label: string; value: CourseStatus }[] = [
  { label: "Nháp",         value: CourseStatus.DRAFT },
  { label: "Đã xuất bản",  value: CourseStatus.PUBLISHED },
  { label: "Lưu trữ",      value: CourseStatus.ARCHIVED },
];

export function CourseStatusSelect({
  courseId,
  slug,
  currentStatus,
}: {
  courseId: string;
  slug: string;
  currentStatus: CourseStatus;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentStatus)}
      disabled={isPending}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => {
          await updateCourseStatus(courseId, slug, option.value);
        });
      }}
    >
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
