"use client";

import { CheckCircleIcon, XCircleIcon, CheckIcon } from "lucide-react";
import type { McqConfig } from "../types";
import { AutoTextarea } from "./auto-textarea";

// ── Student view ──────────────────────────────────────────────────────────────

interface NestedMcqStudentProps {
  questionIndex: number;
  config: McqConfig;
  selected: number; // -1 = unanswered
  locked: boolean;
  revealAnswer: boolean; // AFTER_EACH mode: show ✓/✗ immediately
  onSelect: (idx: number) => void;
}

export function NestedMcqStudent({
  questionIndex,
  config,
  selected,
  locked,
  revealAnswer,
  onSelect,
}: NestedMcqStudentProps) {
  const hasAnswered = selected >= 0;
  const selectedIsCorrect = revealAnswer && selected === config.correctAnswer;
  const questionText = config.question?.trim();

  return (
    <div className="flex flex-col gap-2">
      {questionText && (
        <p className="text-sm font-medium leading-relaxed text-foreground">
          {questionText}
        </p>
      )}
      {revealAnswer && hasAnswered && (
        <p className={`flex items-center gap-1.5 text-xs font-medium ${selectedIsCorrect ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {selectedIsCorrect ? <CheckCircleIcon className="size-3.5" /> : <XCircleIcon className="size-3.5" />}
          {selectedIsCorrect ? "Chính xác" : "Chưa đúng"}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {config.options.map((opt, oi) => {
          const isSelected = selected === oi;
          const isCorrect = revealAnswer && oi === config.correctAnswer;
          const isWrong = revealAnswer && isSelected && oi !== config.correctAnswer;
          const optionStatus = (() => {
            if (revealAnswer && isCorrect && isSelected) return "Bạn chọn - đúng";
            if (revealAnswer && isWrong) return "Bạn chọn - sai";
            if (revealAnswer && isCorrect) return "Đáp án đúng";
            if (isSelected) return "Bạn chọn";
            return "";
          })();

          let cls =
            "w-full text-left px-3 py-2 rounded-md border text-sm flex items-center gap-2 transition-colors";
          if (isCorrect)
            cls += " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 cursor-default";
          else if (isWrong)
            cls += " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 cursor-default";
          else if (isSelected)
            cls += " border-primary bg-primary/10 cursor-default";
          else if (locked || revealAnswer)
            cls += " border-border text-muted-foreground cursor-default opacity-70";
          else
            cls += " border-border hover:border-primary/50 hover:bg-muted/50 cursor-pointer";

          return (
            <button
              key={oi}
              type="button"
              className={cls}
              disabled={locked || revealAnswer}
              onClick={() => onSelect(oi)}
              data-testid={`nested-mcq-${questionIndex}-option-${oi}`}
            >
              {revealAnswer ? (
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
    </div>
  );
}

// ── Editor view ───────────────────────────────────────────────────────────────

interface NestedMcqEditorProps {
  questionIndex: number;
  config: McqConfig;
  onChange: (cfg: McqConfig) => void;
  onRemove?: () => void;
  // When the question lives elsewhere (e.g. listening, where the spoken audio IS
  // the question), hide the question text input and show a custom header label.
  hideQuestion?: boolean;
  label?: string;
}

export function NestedMcqEditor({ questionIndex, config, onChange, onRemove, hideQuestion, label }: NestedMcqEditorProps) {
  function setOptionText(idx: number, text: string) {
    onChange({ ...config, options: config.options.map((o, i) => (i === idx ? { text } : o)) });
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border border-border bg-muted/20">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label ?? `Câu ${questionIndex + 1}`}</span>
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-xs text-destructive hover:underline">
            Xóa
          </button>
        )}
      </div>
      {!hideQuestion && (
        <AutoTextarea
          minRows={2}
          value={config.question ?? ""}
          onChange={(text) => onChange({ ...config, question: text })}
          placeholder={`Nội dung câu hỏi ${questionIndex + 1}`}
          className="rounded border border-input bg-background px-2 py-1.5 text-sm"
        />
      )}
      {config.options.map((opt, oi) => (
        <div key={oi} className="flex items-start gap-2">
          <button
            type="button"
            title={config.correctAnswer === oi ? "Đáp án đúng" : "Chọn làm đáp án đúng"}
            onClick={() => onChange({ ...config, correctAnswer: oi })}
            className={`mt-1 shrink-0 size-5 rounded-full border-2 flex items-center justify-center transition-colors
              ${config.correctAnswer === oi
                ? "border-green-500 bg-green-500 text-white"
                : "border-border hover:border-green-400"}`}
          >
            {config.correctAnswer === oi && <CheckIcon className="size-3" />}
          </button>
          <span className="mt-1.5 text-xs text-muted-foreground w-4 shrink-0 text-center">
            {String.fromCharCode(65 + oi)}.
          </span>
          <AutoTextarea
            value={opt.text}
            onChange={(text) => setOptionText(oi, text)}
            placeholder={`Lựa chọn ${String.fromCharCode(65 + oi)}`}
            className="flex-1 rounded border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      ))}
    </div>
  );
}

// ── Review row ────────────────────────────────────────────────────────────────

interface NestedMcqReviewProps {
  questionIndex: number;
  config: McqConfig;
  selected: number;
  canReveal: boolean;
}

export function NestedMcqReview({ questionIndex, config, selected, canReveal }: NestedMcqReviewProps) {
  const correct = config.correctAnswer;
  const questionText = config.question?.trim() || `Câu ${questionIndex + 1}`;

  return (
    <div className="flex flex-col gap-1 ml-2">
      <p className="text-xs font-medium text-foreground">{questionText}</p>
      <div className="flex flex-col gap-0.5">
        {config.options.map((opt, oi) => {
          const isSelected = selected === oi;
          const isCorrect = canReveal && oi === correct;
          const isWrong = canReveal && isSelected && oi !== correct;
          const optionStatus = (() => {
            if (canReveal && isCorrect && isSelected) return "Bạn chọn - đúng";
            if (canReveal && isWrong) return "Bạn chọn - sai";
            if (canReveal && isCorrect) return "Đáp án đúng";
            if (isSelected) return "Bạn đã chọn";
            return "";
          })();
          let cls = "text-xs px-2 py-1 rounded border flex items-center gap-1.5";
          if (isCorrect)
            cls += " border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400";
          else if (isWrong)
            cls += " border-red-400 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400";
          else if (isSelected && !canReveal)
            cls += " border-primary/50 bg-primary/5";
          else
            cls += " border-transparent text-muted-foreground";
          return (
            <div key={oi} className={cls}>
              {canReveal ? (
                isCorrect ? <CheckCircleIcon className="size-3 shrink-0" /> :
                isWrong ? <XCircleIcon className="size-3 shrink-0" /> :
                <span className="size-3 shrink-0" />
              ) : <span className="size-3 shrink-0" />}
              <span className="min-w-0 flex-1">{String.fromCharCode(65 + oi)}. {opt.text}</span>
              {optionStatus && (
                <span className="ml-auto shrink-0 rounded border border-current/20 px-1.5 py-0.5 text-[10px] font-semibold">
                  {optionStatus}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
