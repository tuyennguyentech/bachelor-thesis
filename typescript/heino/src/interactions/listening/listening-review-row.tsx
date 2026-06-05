"use client";

import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { ReviewRowProps, ListeningConfig, ListeningResponse } from "../types";
import { NestedMcqReview } from "../_shared/nested-mcq";

export function ListeningReviewRow({
  index,
  prompt,
  config,
  response,
  score,
  feedbackMode,
}: ReviewRowProps<ListeningConfig, ListeningResponse>) {
  const canReveal = feedbackMode !== FeedbackMode.HIDDEN;

  return (
    <div className="flex flex-col gap-2 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 size-5 rounded-full flex items-center justify-center text-xs font-medium border ${
            canReveal && score > 0
              ? "bg-green-100 border-green-500 text-green-700 dark:bg-green-950/30 dark:border-green-600 dark:text-green-400"
              : canReveal && (response !== undefined)
              ? "bg-red-100 border-red-400 text-red-600 dark:bg-red-950/30 dark:border-red-500 dark:text-red-400"
              : "bg-muted border-border text-muted-foreground"
          }`}
        >
          {index}
        </span>
        <div className="flex-1 flex flex-col gap-1">
          <p className="text-sm">{prompt}</p>
          <span className="text-xs text-muted-foreground">
            {config.mode === "dictation" ? "🎧 Nghe chép" : "🎧 Nghe hiểu"}
          </span>
        </div>
      </div>

      <div className="ml-7 flex flex-col gap-2">
        {canReveal && config.expectedText && (
          <div className="rounded border border-border bg-muted/20 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">Nội dung nghe</p>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{config.expectedText}</p>
          </div>
        )}

        {config.mode === "dictation" && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Bài làm của học sinh:</p>
            <p className="text-sm border border-border rounded px-2 py-1.5 bg-muted/20">
              {response?.transcription || <span className="italic text-muted-foreground">Chưa trả lời</span>}
            </p>
          </div>
        )}

        {config.mode === "comprehension" &&
          config.comprehensionQuestions.map((q, qi) => (
            <NestedMcqReview
              key={qi}
              questionIndex={qi}
              config={q}
              selected={response?.comprehensionAnswers?.[qi] ?? -1}
              canReveal={canReveal}
            />
          ))}
      </div>
    </div>
  );
}
