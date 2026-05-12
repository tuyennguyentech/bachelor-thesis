"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { analyzeLesson } from "@/app/actions/ai";
import { SparklesIcon, Loader2Icon } from "lucide-react";

interface Props {
  lessonId: string;
  slug: string;
  courseId: string;
}

export function AnalyzeButton({ lessonId, slug, courseId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await analyzeLesson(lessonId, slug, courseId);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="default"
        size="sm"
        disabled={isPending}
        onClick={handleClick}
        className="gap-2 self-start"
      >
        {isPending ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <SparklesIcon className="size-4" />
        )}
        {isPending ? "Đang phân tích…" : "Phân tích video"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
