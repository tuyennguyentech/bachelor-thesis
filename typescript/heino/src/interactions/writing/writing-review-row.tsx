"use client";

import { MessageSquareIcon } from "lucide-react";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { ReviewRowProps, WritingConfig, WritingResponse } from "../types";

export function WritingReviewRow({
  index,
  prompt,
  config,
  response,
  score,
  feedback,
  feedbackMode,
}: ReviewRowProps<WritingConfig, WritingResponse>) {
  const canReveal = feedbackMode !== FeedbackMode.HIDDEN;
  const text = response?.text ?? "";
  const hasResponse = text.trim() !== "";

  return (
    <div data-testid="writing-review-row" className="flex flex-col gap-2 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 size-5 rounded-full flex items-center justify-center text-xs font-medium border ${
            canReveal && score > 0
              ? "bg-green-100 border-green-500 text-green-700 dark:bg-green-950/30 dark:border-green-600 dark:text-green-400"
              : canReveal && hasResponse
              ? "bg-red-100 border-red-400 text-red-600 dark:bg-red-950/30 dark:border-red-500 dark:text-red-400"
              : "bg-muted border-border text-muted-foreground"
          }`}
        >
          {index}
        </span>
        <div className="flex-1 flex flex-col gap-1">
          <p className="text-sm">{prompt || config.prompt}</p>
          <span className="text-xs text-muted-foreground">✍️ Bài viết</span>
        </div>
      </div>

      <div className="ml-7 flex flex-col gap-2">
        {hasResponse ? (
          <div className="rounded border border-border bg-muted/10 px-3 py-2 text-xs whitespace-pre-line leading-relaxed">
            {text}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">Chưa có bài viết.</p>
        )}

        {canReveal && hasResponse && (
          <p className="text-xs">
            <span className="text-muted-foreground">Điểm: </span>
            <span className="font-medium">{Math.round(score * 100)}%</span>
          </p>
        )}

        {canReveal && feedback && hasResponse && (
          <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-950/30">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300">
              <MessageSquareIcon className="size-3.5" />
              Nhận xét
            </div>
            <p
              data-testid="writing-review-feedback"
              className="whitespace-pre-line text-xs leading-relaxed text-blue-700 dark:text-blue-300"
            >
              {feedback}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
