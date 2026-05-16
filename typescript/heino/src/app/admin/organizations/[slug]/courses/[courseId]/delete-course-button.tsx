"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { CourseService } from "buf/gen/richter/v1/courses_pb";

interface Props {
  courseId: string;
  slug: string;
  redirectTo?: string;
  token: string;
}

export function DeleteCourseButton({ courseId, slug, redirectTo, token }: Props) {
  const router = useRouter();
  const courseClient = useRichterWebClient(CourseService, token);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={pending}>Xóa</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xóa khóa học?</AlertDialogTitle>
          <AlertDialogDescription>
            Hành động này không thể hoàn tác. Toàn bộ chương và bài học sẽ bị xóa.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => startTransition(async () => {
              await courseClient.deleteCourse({ id: courseId });
              router.push(redirectTo ?? `/admin/organizations/${slug}/courses`);
            })}
          >
            Xóa
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
