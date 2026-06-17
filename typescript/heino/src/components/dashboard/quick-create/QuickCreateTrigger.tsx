"use client";

import { useState } from "react";
import { ZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuickCreateLessonDialog } from "./QuickCreateLessonDialog";
import type { CourseModule } from "buf/gen/richter/v1/courses_pb";

interface QuickCreateTriggerProps {
  token: string;
  modules: (CourseModule & { lessons?: unknown[] })[];
  courseId: string;
  slug: string;
  /** When set, the dialog runs against an existing video-less lesson. */
  existingLesson?: { id: string; title: string };
  /** Override the button label (defaults differ for new vs existing lesson). */
  label?: string;
  /** Override the button style (defaults to the gradient "tạo nhanh" button). */
  className?: string;
}

export function QuickCreateTrigger({
  token,
  modules,
  courseId,
  slug,
  existingLesson,
  label,
  className,
}: QuickCreateTriggerProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="default"
        size="sm"
        onClick={() => setOpen(true)}
        className={
          className ??
          "gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-sm"
        }
        data-testid={existingLesson ? "quick-create-lesson-trigger" : "quick-create-trigger"}
      >
        <ZapIcon className="size-4" />
        {label ?? "Tạo nhanh bài học"}
      </Button>
      <QuickCreateLessonDialog
        open={open}
        onOpenChange={setOpen}
        token={token}
        modules={modules}
        courseId={courseId}
        slug={slug}
        existingLesson={existingLesson}
      />
    </>
  );
}
