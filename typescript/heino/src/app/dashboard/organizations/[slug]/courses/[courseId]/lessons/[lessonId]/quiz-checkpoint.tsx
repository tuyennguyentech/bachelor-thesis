"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircleIcon, XCircleIcon, PlayIcon } from "lucide-react";

export interface CheckpointQuestion {
  id: string;
  questionText: string;
  options: { text: string }[];
  correctAnswer?: number;
  explanation?: string;
  startSeconds: number;
}

interface Props {
  question: CheckpointQuestion;
  onContinue: () => void;
}

export function QuizCheckpoint({ question, onContinue }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const answered = selected !== null;

  return (
    <div
      data-testid="quiz-checkpoint"
      className="rounded-lg border bg-muted/40 p-4 flex flex-col gap-4"
    >
      <p className="text-sm font-medium">{question.questionText}</p>

      <div className="flex flex-col gap-1 ml-2">
        {question.options.map((opt, oi) => {
          const isSelected = selected === oi;
          const isCorrect = answered && question.correctAnswer !== undefined && oi === question.correctAnswer;
          const isWrong = answered && isSelected && question.correctAnswer !== undefined && oi !== question.correctAnswer;

          let cls =
            "text-sm px-3 py-2 rounded-md border flex items-center gap-2 transition-colors";
          if (!answered) {
            cls += isSelected
              ? " border-primary bg-primary/10 cursor-pointer"
              : " border-border hover:border-muted-foreground cursor-pointer";
          } else {
            if (isCorrect)
              cls +=
                " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400";
            else if (isWrong)
              cls +=
                " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400";
            else cls += " border-transparent text-muted-foreground";
          }

          return (
            <div
              key={oi}
              className={cls}
              onClick={() => { if (!answered) setSelected(oi); }}
            >
              {answered ? (
                isCorrect ? (
                  <CheckCircleIcon className="size-3.5 shrink-0" />
                ) : isWrong ? (
                  <XCircleIcon className="size-3.5 shrink-0" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )
              ) : (
                <div
                  className={`size-3.5 rounded-full border shrink-0 ${isSelected ? "border-primary bg-primary" : "border-muted-foreground"}`}
                />
              )}
              <span>
                {String.fromCharCode(65 + oi)}. {opt.text}
              </span>
            </div>
          );
        })}
      </div>

      {answered && question.explanation && (
        <p className="text-xs text-muted-foreground ml-2 italic">{question.explanation}</p>
      )}

      <Button
        size="sm"
        variant={answered ? "default" : "outline"}
        className="self-start gap-2"
        disabled={!answered}
        onClick={onContinue}
      >
        <PlayIcon className="size-3.5" />
        Tiếp tục xem
      </Button>
    </div>
  );
}
