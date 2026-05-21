"use client";

import { useRef, useState } from "react";
import { CheckCircleIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { StudentViewProps, McqConfig, McqResponse } from "../types";

export function McqStudentView({
  config,
  explanation,
  initialResponse,
  feedbackMode,
  locked,
  onAnswer,
  onContinue,
  hasNextInCheckpoint,
}: StudentViewProps<McqConfig, McqResponse>) {
  const [selected, setSelected] = useState<number>(initialResponse?.selected ?? -1);
  const continueRef = useRef<HTMLButtonElement>(null);
  const hasAnswered = selected >= 0;

  // AFTER_EACH: reveal immediately after selection (server must have sent correctAnswer)
  const revealNow =
    feedbackMode === FeedbackMode.AFTER_EACH && hasAnswered && config.correctAnswer >= 0;

  const selectedIsCorrect = revealNow && selected === config.correctAnswer;

  function handleSelect(idx: number) {
    if (locked || hasAnswered) return;
    setSelected(idx);
    onAnswer({ selected: idx });
    // Auto-focus continue button so Enter key advances
    setTimeout(() => continueRef.current?.focus(), 50);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* AFTER_EACH banner */}
      {revealNow && (
        <div
          className={`flex items-center gap-2 text-sm font-medium px-1 ${
            selectedIsCorrect ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
          }`}
        >
          {selectedIsCorrect ? "✅ Chính xác!" : "❌ Chưa đúng — xem lại nhé"}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {config.options.map((opt, oi) => {
          const isSelected = selected === oi;
          const isCorrect = revealNow && oi === config.correctAnswer;
          const isWrong = revealNow && isSelected && oi !== config.correctAnswer;

          let cls =
            "w-full text-left px-3 py-2.5 rounded-lg border text-sm flex items-center gap-2 transition-colors";

          if (isCorrect)
            cls +=
              " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 cursor-default";
          else if (isWrong)
            cls +=
              " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 cursor-default";
          else if (isSelected)
            cls += " border-primary bg-primary/10 text-foreground cursor-default";
          else if (locked || hasAnswered)
            cls += " border-border text-muted-foreground cursor-default opacity-70";
          else
            cls +=
              " border-border hover:border-primary/50 hover:bg-muted/50 cursor-pointer";

          return (
            <button
              key={oi}
              type="button"
              className={cls}
              disabled={locked || hasAnswered}
              onClick={() => handleSelect(oi)}
            >
              {revealNow ? (
                isCorrect ? (
                  <CheckCircleIcon className="size-4 shrink-0 text-green-500" />
                ) : isWrong ? (
                  <XCircleIcon className="size-4 shrink-0 text-red-500" />
                ) : (
                  <span className="size-4 shrink-0 inline-flex items-center justify-center rounded-full border border-border text-xs text-muted-foreground">
                    {String.fromCharCode(65 + oi)}
                  </span>
                )
              ) : (
                <span
                  className={`size-4 shrink-0 inline-flex items-center justify-center rounded-full border text-xs font-medium
                    ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}
                >
                  {String.fromCharCode(65 + oi)}
                </span>
              )}
              <span>{opt.text}</span>
            </button>
          );
        })}
      </div>

      {/* AFTER_EACH: explanation (shown for both correct and wrong) */}
      {revealNow && explanation && (
        <p className="text-xs text-muted-foreground px-1">
          💡 {explanation}
        </p>
      )}

      {/* AFTER_SUBMIT / HIDDEN: acknowledgement text */}
      {hasAnswered && !revealNow && (
        <p className="text-xs text-muted-foreground px-1">✓ Đã ghi nhận đáp án</p>
      )}

      {hasAnswered && (
        <Button ref={continueRef} size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          {hasNextInCheckpoint ? "Câu tiếp theo →" : "▶ Tiếp tục xem"}
        </Button>
      )}
    </div>
  );
}
