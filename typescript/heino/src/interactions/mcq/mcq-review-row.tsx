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
  const isMultiple = Array.isArray(config.correctAnswers);

  const selected = response?.selected ?? -1;
  const selectedIndexes = response?.selectedIndexes ?? [];

  const correct = config.correctAnswer;
  const correctAnswers = config.correctAnswers || [];

  const canReveal = feedbackMode !== FeedbackMode.HIDDEN &&
    (isMultiple ? correctAnswers.length > 0 : correct >= 0);

  const hasAnswered = isMultiple ? selectedIndexes.length > 0 : selected >= 0;

  return (
    <div className="flex flex-col gap-2 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 size-5 rounded flex items-center justify-center text-xs font-semibold border ${
            canReveal && score > 0
              ? "bg-green-100 border-green-500 text-green-700 dark:bg-green-950/30 dark:border-green-600 dark:text-green-400"
              : canReveal && hasAnswered
              ? "bg-red-100 border-red-400 text-red-600 dark:bg-red-950/30 dark:border-red-500 dark:text-red-400"
              : "bg-muted border-border text-muted-foreground"
          } ${isMultiple ? "rounded-sm" : "rounded-full"}`}
        >
          {index}
        </span>
        <p className="text-sm font-medium">{prompt}</p>
      </div>

      <div className="flex flex-col gap-1 ml-7">
        {config.options.map((opt, oi) => {
          const isSelected = isMultiple ? selectedIndexes.includes(oi) : selected === oi;

          const isCorrect = canReveal && (isMultiple
            ? correctAnswers.includes(oi)
            : oi === correct);

          const isWrong = canReveal && isSelected && (isMultiple
            ? !correctAnswers.includes(oi)
            : oi !== correct);
          const optionStatus = (() => {
            if (canReveal && isCorrect && isSelected) return "Bạn chọn - đúng";
            if (canReveal && isWrong) return "Bạn chọn - sai";
            if (canReveal && isCorrect) return "Đáp án đúng";
            if (isSelected) return "Bạn đã chọn";
            return "";
          })();

          let cls = "text-xs px-2.5 py-1.5 rounded border flex items-center gap-2 transition-all";

          if (isCorrect)
            cls += " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 font-medium";
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
                  <CheckCircleIcon className="size-3.5 shrink-0 text-green-500" />
                ) : isWrong ? (
                  <XCircleIcon className="size-3.5 shrink-0 text-red-500" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <span>
                {String.fromCharCode(65 + oi)}. {opt.text}
              </span>
              {optionStatus && (
                <span className="ml-auto shrink-0 rounded border border-current/20 px-1.5 py-0.5 text-[10px] font-semibold">
                  {optionStatus}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {canReveal && explanation && score === 0 && (
        <p className="text-xs text-muted-foreground ml-7 italic bg-muted/20 px-3 py-1.5 rounded border border-dashed">{explanation}</p>
      )}
    </div>
  );
}
