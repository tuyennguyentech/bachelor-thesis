"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { QuizService } from "buf/gen/richter/v1/quiz_pb";
import { ConnectError } from "@connectrpc/connect";
import { CheckCircleIcon, XCircleIcon, SendIcon } from "lucide-react";
import type { QuizAttempt } from "buf/gen/richter/v1/quiz_pb";

export interface SafeQuestion {
  id: string;
  questionText: string;
  options: { text: string }[];
  explanation: string;
}

interface Props {
  questions: SafeQuestion[];
  previousAttempt: QuizAttempt | null;
  /** Correct answers provided server-side only after the user has already submitted. */
  initialCorrectAnswers?: number[];
  lessonId: string;
  isPreview?: boolean;
  token: string;
}

export function QuizForm({ questions, previousAttempt, initialCorrectAnswers, lessonId, isPreview, token }: Props) {
  const quizClient = useRichterWebClient(QuizService, token);
  const [selected, setSelected] = useState<(number | null)[]>(() =>
    Array.from({ length: questions.length }, (_, i) =>
      previousAttempt ? ((previousAttempt.answers ?? [])[i] ?? null) : null,
    ),
  );
  const [result, setResult] = useState<{ score: number; total: number } | null>(
    previousAttempt ? { score: previousAttempt.score, total: previousAttempt.total } : null,
  );
  const [correctAnswers, setCorrectAnswers] = useState<number[] | undefined>(initialCorrectAnswers);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submitted = result !== null;

  function handleSelect(qi: number, oi: number) {
    if (submitted) return;
    setSelected((prev) => {
      const next = [...prev];
      next[qi] = oi;
      return next;
    });
  }

  function handleSubmit() {
    if (!selected.every((v) => v !== null)) return;
    const answers = selected as number[];
    setError(null);
    startTransition(async () => {
      try {
        const ca = initialCorrectAnswers ?? [];
        const revealedAnswers = ca.length > 0 ? ca : undefined;
        if (isPreview) {
          const score = ca.length > 0
            ? answers.filter((a, i) => a === (ca[i] ?? -1)).length
            : 0;
          setResult({ score, total: ca.length });
          setCorrectAnswers(revealedAnswers);
          setSelected(answers);
        } else {
          const res = await quizClient.submitQuiz({ lessonId, answers });
          setResult({ score: res.attempt?.score ?? 0, total: res.attempt?.total ?? 0 });
          setCorrectAnswers(revealedAnswers);
          setSelected(answers);
        }
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Nộp bài thất bại. Vui lòng thử lại.");
      }
    });
  }

  const allAnswered = selected.every((v) => v !== null);

  return (
    <div className="flex flex-col gap-6">
      {submitted && result && (
        <div className="rounded-md bg-muted px-4 py-3 flex items-center gap-3">
          <CheckCircleIcon className="size-5 text-green-500 shrink-0" />
          <span className="text-sm font-medium">
            Kết quả: {result.score}/{result.total} câu đúng (
            {result.total > 0 ? Math.round((result.score / result.total) * 100) : 0}%)
          </span>
        </div>
      )}

      {questions.map((q, qi) => {
        const sel = selected[qi];
        const hasAnswers = correctAnswers != null && correctAnswers.length > 0;
        const correct = hasAnswers ? (correctAnswers[qi] ?? -1) : -1;
        return (
          <div key={q.id} className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              {qi + 1}. {q.questionText}
            </p>
            <div className="flex flex-col gap-1 ml-4">
              {q.options.map((opt, oi) => {
                const isSelected = sel === oi;
                const isCorrect = hasAnswers && oi === correct;
                let className =
                  "text-sm px-3 py-2 rounded-md border cursor-pointer transition-colors flex items-center gap-2";
                if (submitted && hasAnswers) {
                  if (isCorrect) {
                    className += " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400";
                  } else if (isSelected) {
                    className += " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400";
                  } else {
                    className += " border-transparent text-muted-foreground";
                  }
                } else {
                  className += isSelected
                    ? " border-primary bg-primary/10"
                    : submitted
                    ? " border-transparent text-muted-foreground"
                    : " border-border hover:border-muted-foreground";
                }
                return (
                  <div key={oi} className={className} onClick={() => handleSelect(qi, oi)}>
                    {submitted && hasAnswers ? (
                      isCorrect ? (
                        <CheckCircleIcon className="size-3.5 shrink-0" />
                      ) : isSelected ? (
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
            {submitted && hasAnswers && q.explanation && (
              <p className="text-xs text-muted-foreground ml-4 italic">{q.explanation}</p>
            )}
          </div>
        );
      })}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!submitted && (
        <Button
          size="sm"
          className="self-start gap-2"
          disabled={!allAnswered || isPending}
          onClick={handleSubmit}
        >
          <SendIcon className="size-4" />
          {isPending ? "Đang nộp…" : "Nộp bài"}
        </Button>
      )}

      {submitted && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            setSelected(Array(questions.length).fill(null));
            setResult(null);
            setCorrectAnswers(undefined);
            setError(null);
          }}
        >
          Làm lại
        </Button>
      )}
    </div>
  );
}
