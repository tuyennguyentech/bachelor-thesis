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
}

export function QuickCreateTrigger({ token, modules, courseId, slug }: QuickCreateTriggerProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="default"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-sm"
        data-testid="quick-create-trigger"
      >
        <ZapIcon className="size-4" />
        Tạo nhanh bài học
      </Button>
      <QuickCreateLessonDialog
        open={open}
        onOpenChange={setOpen}
        token={token}
        modules={modules}
        courseId={courseId}
        slug={slug}
      />
    </>
  );
}
