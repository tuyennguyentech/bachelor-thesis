"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { StudentViewProps, ReadingConfig, ReadingResponse } from "../types";
import { NestedMcqStudent } from "../_shared/nested-mcq";

export function ReadingStudentView({
  config,
  feedbackMode,
  locked,
  initialResponse,
  onAnswer,
  onContinue,
}: StudentViewProps<ReadingConfig, ReadingResponse>) {
  const [answers, setAnswers] = useState<number[]>(
    initialResponse?.answers ?? config.questions.map(() => -1)
  );
  const allAnswered = answers.every((a) => a >= 0);

  function handleSelect(qi: number, idx: number) {
    const next = answers.map((a, i) => (i === qi ? idx : a));
    setAnswers(next);
    onAnswer({ answers: next });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Passage */}
      <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/20 px-4 py-3 text-sm">
        <ReactMarkdown>{config.passageMarkdown}</ReactMarkdown>
      </div>

      {/* Questions */}
      <div className="flex flex-col gap-4">
        {config.questions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-2">
            <p className="text-sm font-medium">Câu {qi + 1}</p>
            <NestedMcqStudent
              questionIndex={qi}
              config={q}
              selected={answers[qi] ?? -1}
              locked={locked}
              revealAnswer={feedbackMode === FeedbackMode.AFTER_EACH && (answers[qi] ?? -1) >= 0}
              onSelect={(idx) => handleSelect(qi, idx)}
            />
          </div>
        ))}
      </div>

      {allAnswered && (
        <Button size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          ▶ Tiếp tục xem
        </Button>
      )}
    </div>
  );
}
