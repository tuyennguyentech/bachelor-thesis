"use client";

import { CheckCircleIcon, XCircleIcon } from "lucide-react";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { ReviewRowProps, FillBlankConfig, FillBlankResponse } from "../types";

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

export function FillBlankReviewRow({
  index,
  prompt: _prompt,
  explanation,
  config,
  response,
  score,
  feedbackMode,
}: ReviewRowProps<FillBlankConfig, FillBlankResponse>) {
  const canReveal = feedbackMode !== FeedbackMode.HIDDEN;
  const parts = parseTemplate(config.template);
  const answers = response?.answers ?? [];

  return (
    <div className="flex flex-col gap-2 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 size-5 rounded-full flex items-center justify-center text-xs font-medium border ${
            canReveal && score === config.blanks.length
              ? "bg-green-100 border-green-500 text-green-700 dark:bg-green-950/30 dark:border-green-600 dark:text-green-400"
              : canReveal && score > 0
              ? "bg-yellow-100 border-yellow-500 text-yellow-700 dark:bg-yellow-950/30 dark:border-yellow-600 dark:text-yellow-400"
              : canReveal && answers.length > 0
              ? "bg-red-100 border-red-400 text-red-600 dark:bg-red-950/30 dark:border-red-500 dark:text-red-400"
              : "bg-muted border-border text-muted-foreground"
          }`}
        >
          {index}
        </span>
        <p className="text-sm leading-relaxed">
          {parts.map((part, pi) => {
            if (part.type === "text") return <span key={pi}>{part.value}</span>;
            const idx = part.index;
            const val = answers[idx] ?? "";
            const correct = canReveal && val !== "" ? isCorrectAnswer(config.blanks[idx], val) : null;
            return (
              <span key={pi} className="inline-flex items-center gap-0.5 mx-0.5 align-baseline">
                <span
                  className={`inline-block rounded border px-1.5 py-0.5 text-sm min-w-[4rem] text-center
                    ${correct === true ? "border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                    : correct === false ? "border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400"
                    : val ? "border-border bg-muted text-foreground"
                    : "border-dashed border-border text-muted-foreground italic"}`}
                >
                  {val || "—"}
                </span>
                {correct === true && <CheckCircleIcon className="size-3.5 text-green-500 shrink-0" />}
                {correct === false && <XCircleIcon className="size-3.5 text-red-500 shrink-0" />}
              </span>
            );
          })}
        </p>
      </div>

      {canReveal && (
        <div className="ml-7 flex flex-col gap-1">
          {config.blanks.map((blank, i) => {
            const got = answers[i] ?? "";
            const correct = got !== "" && isCorrectAnswer(blank, got);
            if (correct) return null;
            return (
              <p key={i} className="text-xs text-muted-foreground">
                Chỗ trống {i + 1} — đáp án:{" "}
                <span className="font-medium text-foreground">{blank.accepted.join(" / ")}</span>
              </p>
            );
          })}
        </div>
      )}

      {canReveal && explanation && score < config.blanks.length && (
        <p className="text-xs text-muted-foreground ml-7 italic">{explanation}</p>
      )}
    </div>
  );
}
