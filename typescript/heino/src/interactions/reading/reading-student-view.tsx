"use client";

import ReactMarkdown from "react-markdown";
import type { StudentViewProps, ReadingConfig, ReadingResponse } from "../types";

export function ReadingStudentView({
  config,
}: StudentViewProps<ReadingConfig, ReadingResponse>) {
  return (
    <div className="flex flex-col gap-4">
      <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/20 px-4 py-3 text-sm">
        <ReactMarkdown>{config.passageMarkdown}</ReactMarkdown>
      </div>
      {config.mode === "open_answer" && config.question && (
        <p className="text-sm font-medium">{config.question}</p>
      )}
      <p className="text-xs text-muted-foreground italic">
        🎙 Ghi âm sắp ra mắt (STEP 7)
      </p>
    </div>
  );
}
