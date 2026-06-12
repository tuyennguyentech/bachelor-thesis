"use client";

import { useRef, useState } from "react";
import { ArrowRightIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StudentViewProps, WritingConfig, WritingResponse } from "../types";

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

export function WritingStudentView({
  config,
  initialResponse,
  locked,
  onAnswer,
  onContinue,
  hasNextInCheckpoint,
}: StudentViewProps<WritingConfig, WritingResponse>) {
  const [text, setText] = useState<string>(initialResponse?.text ?? "");
  const [submitted, setSubmitted] = useState(!!initialResponse);
  const continueRef = useRef<HTMLButtonElement>(null);

  const wordCount = countWords(text);
  const meetsMinimum = config.minWords <= 0 || wordCount >= config.minWords;
  const canSubmit = text.trim() !== "" && meetsMinimum;

  function handleChange(val: string) {
    if (locked || submitted) return;
    setText(val);
  }

  function handleSubmit() {
    if (submitted || locked || !canSubmit) return;
    setSubmitted(true);
    onAnswer({ text });
    setTimeout(() => continueRef.current?.focus(), 50);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Prompt */}
      <p className="text-sm font-medium">{config.prompt}</p>

      {/* Rubric */}
      {config.rubric && (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Tiêu chí chấm điểm</p>
          <p className="whitespace-pre-line leading-relaxed">{config.rubric}</p>
        </div>
      )}

      {/* Essay textarea */}
      <textarea
        data-testid="writing-student-textarea"
        rows={8}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        disabled={locked || submitted}
        placeholder="Viết bài của bạn ở đây…"
        className="text-sm rounded-md border border-input bg-background px-3 py-2 resize-y focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-70"
      />

      {/* Word count + minimum indicator */}
      <p className="text-xs text-muted-foreground">
        Số từ: <span className="font-medium tabular-nums">{wordCount}</span>
        {config.minWords > 0 && (
          <>
            {" / "}
            <span className={meetsMinimum ? "" : "text-destructive"}>tối thiểu {config.minWords}</span>
          </>
        )}
      </p>

      {submitted && (
        <p className="text-xs text-muted-foreground px-1">✓ Đã nộp bài viết, AI sẽ chấm điểm.</p>
      )}

      {!submitted && (
        <Button
          type="button"
          data-testid="writing-submit"
          size="sm"
          className="self-start"
          disabled={!canSubmit || locked}
          onClick={handleSubmit}
        >
          Nộp bài
        </Button>
      )}

      {submitted && (
        <Button ref={continueRef} size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
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
