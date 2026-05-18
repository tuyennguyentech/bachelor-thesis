"use client";

import { useRef, useState } from "react";
import { CheckCircleIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { StudentViewProps, FillBlankConfig, FillBlankResponse } from "../types";

const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

type Part =
  | { type: "text"; value: string }
  | { type: "blank"; index: number };

function parseTemplate(template: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (m.index! > last) parts.push({ type: "text", value: template.slice(last, m.index) });
    parts.push({ type: "blank", index: parseInt(m[1], 10) });
    last = m.index! + m[0].length;
  }
  if (last < template.length) parts.push({ type: "text", value: template.slice(last) });
  return parts;
}

function isCorrectAnswer(blank: FillBlankConfig["blanks"][number], got: string): boolean {
  return blank.accepted.some((want) =>
    blank.caseSensitive ? got === want : got.trim().toLowerCase() === want.trim().toLowerCase()
  );
}

export function FillBlankStudentView({
  config,
  explanation,
  initialResponse,
  feedbackMode,
  locked,
  onAnswer,
  onContinue,
}: StudentViewProps<FillBlankConfig, FillBlankResponse>) {
  const [answers, setAnswers] = useState<string[]>(
    initialResponse?.answers ?? config.blanks.map(() => "")
  );
  const [submitted, setSubmitted] = useState(!!initialResponse);
  const continueRef = useRef<HTMLButtonElement>(null);

  const parts = parseTemplate(config.template);
  const allFilled = answers.every((a) => a.trim() !== "");

  const revealNow = feedbackMode === FeedbackMode.AFTER_EACH && submitted;

  function handleSubmit() {
    if (submitted || locked) return;
    setSubmitted(true);
    onAnswer({ answers });
    setTimeout(() => continueRef.current?.focus(), 50);
  }

  function handleChange(idx: number, val: string) {
    if (submitted || locked) return;
    setAnswers((prev) => prev.map((a, i) => (i === idx ? val : a)));
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed">
        {parts.map((part, pi) => {
          if (part.type === "text") return <span key={pi}>{part.value}</span>;
          const idx = part.index;
          const val = answers[idx] ?? "";
          const correct = revealNow ? isCorrectAnswer(config.blanks[idx], val) : null;
          const hint = config.blanks[idx]?.hint;
          return (
            <span key={pi} className="inline-flex items-center gap-0.5 mx-0.5 align-baseline">
              <input
                type="text"
                data-testid={`fill-blank-input-${idx}`}
                value={val}
                onChange={(e) => handleChange(idx, e.target.value)}
                disabled={submitted || locked}
                placeholder={hint || `(${idx + 1})`}
                className={`rounded border px-1.5 py-0.5 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-ring
                  ${correct === true ? "border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                  : correct === false ? "border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400"
                  : submitted ? "border-border bg-muted text-foreground"
                  : "border-input bg-background text-foreground"}`}
              />
              {revealNow &&
                (correct ? (
                  <CheckCircleIcon className="size-4 text-green-500 shrink-0" />
                ) : (
                  <XCircleIcon className="size-4 text-red-500 shrink-0" />
                ))}
            </span>
          );
        })}
      </p>

      {revealNow && explanation && (
        <p className="text-xs text-muted-foreground px-1">💡 {explanation}</p>
      )}

      {submitted && !revealNow && (
        <p className="text-xs text-muted-foreground px-1">✓ Đã ghi nhận đáp án</p>
      )}

      {!submitted && (
        <Button
          type="button"
          data-testid="fill-blank-submit"
          size="sm"
          className="self-start"
          disabled={!allFilled || locked}
          onClick={handleSubmit}
        >
          Trả lời
        </Button>
      )}

      {submitted && (
        <Button ref={continueRef} size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          ▶ Tiếp tục xem
        </Button>
      )}
    </div>
  );
}
