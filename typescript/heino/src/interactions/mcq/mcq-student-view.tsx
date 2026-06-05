"use client";

import { useRef, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, LightbulbIcon, PlayIcon, XCircleIcon, CheckSquare2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
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
  kind,
}: StudentViewProps<McqConfig, McqResponse>) {
  const isMultiple = kind === InteractionKind.MULTIPLE_CHOICE;

  // Single Choice states
  const [selected, setSelected] = useState<number>(initialResponse?.selected ?? -1);

  // Multiple Choice states
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>(initialResponse?.selectedIndexes ?? []);
  const [multipleSubmitted, setMultipleSubmitted] = useState<boolean>(
    initialResponse !== null && (initialResponse.selectedIndexes !== undefined || initialResponse.selected !== undefined)
  );

  const continueRef = useRef<HTMLButtonElement>(null);

  const hasAnswered = isMultiple ? multipleSubmitted : selected >= 0;

  // AFTER_EACH: reveal immediately after selection or confirmation
  const revealNow = (() => {
    if (feedbackMode !== FeedbackMode.AFTER_EACH || !hasAnswered) return false;
    if (isMultiple) {
      return Array.isArray(config.correctAnswers);
    }
    return config.correctAnswer >= 0;
  })();

  const selectedIsCorrect = (() => {
    if (!revealNow) return false;
    if (isMultiple) {
      const correct = config.correctAnswers || [];
      return correct.length === selectedIndexes.length &&
        correct.every((a) => selectedIndexes.includes(a));
    }
    return selected === config.correctAnswer;
  })();

  function handleSelectSingle(idx: number) {
    if (locked || revealNow) return;
    setSelected(idx);
    onAnswer({ selected: idx, selectedIndexes: [] });
    // Auto-focus continue button so Enter key advances
    setTimeout(() => continueRef.current?.focus(), 50);
  }

  function handleToggleMultiple(idx: number) {
    if (locked || hasAnswered) return;
    setSelectedIndexes((prev) => {
      const next = prev.includes(idx)
        ? prev.filter((i) => i !== idx)
        : [...prev, idx];
      return next;
    });
  }

  function handleConfirmMultiple() {
    if (locked || hasAnswered) return;
    setMultipleSubmitted(true);
    onAnswer({ selected: -1, selectedIndexes });
    // Auto-focus continue button
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
          {selectedIsCorrect ? (
            <>
              <CheckCircleIcon className="size-4" />
              Chính xác
            </>
          ) : (
            <>
              <XCircleIcon className="size-4" />
              Chưa đúng, xem lại nhé
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {config.options.map((opt, oi) => {
          const isSelected = isMultiple ? selectedIndexes.includes(oi) : selected === oi;

          const isCorrect = (() => {
            if (!revealNow) return false;
            if (isMultiple) {
              return (config.correctAnswers || []).includes(oi);
            }
            return oi === config.correctAnswer;
          })();

          const isWrong = (() => {
            if (!revealNow) return false;
            if (isMultiple) {
              return isSelected && !(config.correctAnswers || []).includes(oi);
            }
            return isSelected && oi !== config.correctAnswer;
          })();
          const optionStatus = (() => {
            if (revealNow && isCorrect && isSelected) return "Bạn chọn - đúng";
            if (revealNow && isWrong) return "Bạn chọn - sai";
            if (revealNow && isCorrect) return "Đáp án đúng";
            if (isSelected) return "Bạn chọn";
            return "";
          })();

          let cls =
            "w-full text-left px-3 py-2.5 rounded-md border text-sm flex items-center gap-2 transition-colors";

          if (isCorrect)
            cls +=
              " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 cursor-default";
          else if (isWrong)
            cls +=
              " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 cursor-default";
          else if (isSelected)
            cls += " border-primary bg-primary/10 text-foreground cursor-default";
          else if (locked || revealNow)
            cls += " border-border text-muted-foreground cursor-default opacity-70";
          else
            cls +=
              " border-border hover:border-primary/50 hover:bg-muted/50 cursor-pointer";

          return (
            <button
              key={oi}
              type="button"
              className={cls}
              disabled={locked || revealNow}
              onClick={() => (isMultiple ? handleToggleMultiple(oi) : handleSelectSingle(oi))}
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
                  className={`size-4 shrink-0 inline-flex items-center justify-center border text-xs font-semibold
                    ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}
                    ${isMultiple ? "rounded-sm" : "rounded-full"}`}
                >
                  {isSelected && isMultiple ? (
                    <CheckSquare2 className="size-3 text-primary-foreground bg-primary" />
                  ) : (
                    String.fromCharCode(65 + oi)
                  )}
                </span>
              )}
              <span className="min-w-0 flex-1">{opt.text}</span>
              {optionStatus && (
                <span className="ml-auto shrink-0 rounded border border-current/20 px-1.5 py-0.5 text-[11px] font-medium">
                  {optionStatus}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Multiple Choice: Confirm Button */}
      {isMultiple && !hasAnswered && (
        <Button
          size="sm"
          className="self-start mt-1"
          onClick={handleConfirmMultiple}
          disabled={locked || selectedIndexes.length === 0}
        >
          Xác nhận đáp án
        </Button>
      )}

      {/* AFTER_EACH: explanation (shown for both correct and wrong) */}
      {revealNow && explanation && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <LightbulbIcon className="mt-0.5 size-3.5 shrink-0" />
          <p>{explanation}</p>
        </div>
      )}

      {/* AFTER_SUBMIT / HIDDEN: acknowledgement text */}
      {hasAnswered && !revealNow && (
        <p className="text-xs text-muted-foreground px-1">✓ Đã ghi nhận đáp án</p>
      )}

      {hasAnswered && (
        <Button ref={continueRef} size="sm" className="self-start gap-1.5 mt-1" onClick={onContinue} disabled={locked}>
          {hasNextInCheckpoint ? (
            <>
              Câu tiếp theo
              <ArrowRightIcon className="size-4" />
            </>
          ) : (
            <>
              <PlayIcon className="size-4" />
              Tiếp tục xem
            </>
          )}
        </Button>
      )}
    </div>
  );
}
