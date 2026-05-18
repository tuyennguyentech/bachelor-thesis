"use client";

import { CheckCircleIcon, XCircleIcon } from "lucide-react";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { ReviewRowProps, McqConfig, McqResponse } from "../types";

export function McqReviewRow({
  index,
  prompt,
  explanation,
  config,
  response,
  score,
  feedbackMode,
}: ReviewRowProps<McqConfig, McqResponse>) {
  const selected = response?.selected ?? -1;
  const correct = config.correctAnswer;
  const canReveal = feedbackMode !== FeedbackMode.HIDDEN && correct >= 0;

  return (
    <div className="flex flex-col gap-2 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 size-5 rounded-full flex items-center justify-center text-xs font-medium border ${
            canReveal && score > 0
              ? "bg-green-100 border-green-500 text-green-700 dark:bg-green-950/30 dark:border-green-600 dark:text-green-400"
              : canReveal && selected >= 0
              ? "bg-red-100 border-red-400 text-red-600 dark:bg-red-950/30 dark:border-red-500 dark:text-red-400"
              : "bg-muted border-border text-muted-foreground"
          }`}
        >
          {index}
        </span>
        <p className="text-sm">{prompt}</p>
      </div>
      <div className="flex flex-col gap-0.5 ml-7">
        {config.options.map((opt, oi) => {
          const isSelected = selected === oi;
          const isCorrect = canReveal && oi === correct;
          const isWrong = canReveal && isSelected && oi !== correct;
          let cls = "text-xs px-2 py-1.5 rounded border flex items-center gap-1.5";
          if (isCorrect)
            cls += " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400";
          else if (isWrong)
            cls += " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400";
          else if (isSelected && !canReveal)
            cls += " border-primary/50 bg-primary/5 text-foreground";
          else
            cls += " border-transparent text-muted-foreground";
          return (
            <div key={oi} className={cls}>
              {canReveal ? (
                isCorrect ? (
                  <CheckCircleIcon className="size-3 shrink-0" />
                ) : isWrong ? (
                  <XCircleIcon className="size-3 shrink-0" />
                ) : (
                  <span className="size-3 shrink-0" />
                )
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <span>
                {String.fromCharCode(65 + oi)}. {opt.text}
              </span>
            </div>
          );
        })}
      </div>
      {canReveal && explanation && score === 0 && (
        <p className="text-xs text-muted-foreground ml-7 italic">{explanation}</p>
      )}
    </div>
  );
}
