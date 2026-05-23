"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CourseStatus } from "buf/gen/richter/v1/courses_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { CourseService } from "buf/gen/richter/v1/courses_pb";

const STATUS_OPTIONS: { label: string; value: CourseStatus }[] = [
  { label: "Nháp",         value: CourseStatus.DRAFT },
  { label: "Đã xuất bản",  value: CourseStatus.PUBLISHED },
  { label: "Lưu trữ",      value: CourseStatus.ARCHIVED },
];

interface Props {
  courseId: string;
  slug: string;
  currentStatus: CourseStatus;
  token: string;
}

export function CourseStatusSelect({ courseId, currentStatus, token }: Props) {
  const router = useRouter();
  const courseClient = useRichterWebClient(CourseService, token);
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      defaultValue={String(currentStatus)}
      disabled={isPending}
      onValueChange={(val) => {
        const option = STATUS_OPTIONS.find((o) => String(o.value) === val);
        if (!option) return;
        startTransition(async () => {
          await courseClient.updateCourseStatus({ id: courseId, status: option.value });
          router.refresh();
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
