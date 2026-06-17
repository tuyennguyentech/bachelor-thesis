"use client";

import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import { MinusIcon, PlusIcon } from "lucide-react";

export const KIND_OPTIONS = [
  { kind: InteractionKind.SINGLE_CHOICE, label: "Trắc nghiệm 1 đáp án", shortLabel: "MCQ", description: "Kiểm tra khái niệm trọng tâm." },
  { kind: InteractionKind.MULTIPLE_CHOICE, label: "Trắc nghiệm nhiều đáp án", shortLabel: "Multi", description: "Phù hợp câu hỏi phân biệt nhiều ý đúng." },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án", shortLabel: "Điền", description: "Buộc học viên nhớ thuật ngữ hoặc bước xử lý." },
  { kind: InteractionKind.READING, label: "Bài đọc", shortLabel: "Đọc", description: "Sinh đoạn đọc ngắn kèm câu hỏi hiểu nội dung." },
  { kind: InteractionKind.LISTENING, label: "Bài nghe", shortLabel: "Nghe", description: "Sinh audio TTS và câu hỏi nghe hiểu." },
] as const;

const KNOWN_KINDS = [InteractionKind.SINGLE_CHOICE, InteractionKind.MULTIPLE_CHOICE, InteractionKind.FILL_BLANK, InteractionKind.READING, InteractionKind.LISTENING] as const;

const KIND_STYLE: Record<typeof KNOWN_KINDS[number], { active: string; idle: string; badge: string; rail: string; dot: string }> = {
  [InteractionKind.SINGLE_CHOICE]: {
    active: "border-rose-400/45 bg-rose-500/10",
    idle: "border-border bg-background hover:bg-rose-500/5",
    badge: "bg-rose-500/15 text-rose-600 dark:text-rose-300",
    rail: "bg-rose-500",
    dot: "bg-rose-500/80",
  },
  [InteractionKind.MULTIPLE_CHOICE]: {
    active: "border-violet-400/45 bg-violet-500/10",
    idle: "border-border bg-background hover:bg-violet-500/5",
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
    rail: "bg-violet-500",
    dot: "bg-violet-500/80",
  },
  [InteractionKind.FILL_BLANK]: {
    active: "border-emerald-400/45 bg-emerald-500/10",
    idle: "border-border bg-background hover:bg-emerald-500/5",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    rail: "bg-emerald-500",
    dot: "bg-emerald-500/80",
  },
  [InteractionKind.READING]: {
    active: "border-sky-400/45 bg-sky-500/10",
    idle: "border-border bg-background hover:bg-sky-500/5",
    badge: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
    rail: "bg-sky-500",
    dot: "bg-sky-500/80",
  },
  [InteractionKind.LISTENING]: {
    active: "border-amber-400/45 bg-amber-500/10",
    idle: "border-border bg-background hover:bg-amber-500/5",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    rail: "bg-amber-500",
    dot: "bg-amber-500/80",
  },
};

export type KindQuantities = {
  [InteractionKind.SINGLE_CHOICE]: number;
  [InteractionKind.MULTIPLE_CHOICE]: number;
  [InteractionKind.FILL_BLANK]: number;
  [InteractionKind.READING]: number;
  [InteractionKind.LISTENING]: number;
};

export function emptyQuantities(): KindQuantities {
  return {
    [InteractionKind.SINGLE_CHOICE]: 0,
    [InteractionKind.MULTIPLE_CHOICE]: 0,
    [InteractionKind.FILL_BLANK]: 0,
    [InteractionKind.READING]: 0,
    [InteractionKind.LISTENING]: 0,
  };
}

export function fromConfig(cfg: ChunkInteractionConfig | undefined): KindQuantities {
  const result = emptyQuantities();
  // No saved config → open with everything at 0 so the manager consciously
  // chooses how many of each kind to generate (the generate button stays
  // disabled until the total is > 0). Previously this pre-filled 1 single-choice,
  // which silently biased every fresh "Tạo bài tập bằng AI" run toward 1 MCQ.
  if (!cfg) return result;

  const validKinds = cfg.kinds.filter((k): k is typeof KNOWN_KINDS[number] => KNOWN_KINDS.includes(k as typeof KNOWN_KINDS[number]));
  for (const k of validKinds) result[k] = (result[k] ?? 0) + 1;

  const sumFromKinds = Object.values(result).reduce((a, b) => a + b, 0);
  if (sumFromKinds !== cfg.count) {
    // Legacy format: unique kinds + AI_CHOOSE — redistribute count evenly
    KNOWN_KINDS.forEach(k => { result[k] = 0; });
    const uniqueKinds = [...new Set(validKinds)];
    if (uniqueKinds.length > 0) {
      const per = Math.floor(cfg.count / uniqueKinds.length);
      const rem = cfg.count % uniqueKinds.length;
      uniqueKinds.forEach((k, i) => { result[k] = per + (i < rem ? 1 : 0); });
    }
  }
  return result;
}

export function toKindsList(quantities: KindQuantities): InteractionKind[] {
  const kinds: InteractionKind[] = [];
  for (const { kind } of KIND_OPTIONS) {
    for (let i = 0; i < (quantities[kind] ?? 0); i++) kinds.push(kind);
  }
  return kinds;
}

export function totalQuantity(quantities: KindQuantities): number {
  return Object.values(quantities).reduce((a, b) => a + b, 0);
}

interface StepperProps {
  value: number;
  onChange: (n: number) => void;
  label: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}

function clampQuantity(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function Stepper({ value, onChange, label, min = 0, max = 8, disabled }: StepperProps) {
  const update = (next: number) => onChange(clampQuantity(next, min, max));

  return (
    <div className="inline-grid h-10 shrink-0 grid-cols-[2.5rem_3.25rem_2.5rem] overflow-hidden rounded-xl border border-input bg-background shadow-sm">
      <button
        type="button"
        aria-label={`Giảm ${label}`}
        className="flex items-center justify-center border-r border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        onClick={(event) => {
          event.stopPropagation();
          update(value - 1);
        }}
        disabled={disabled || value <= min}
      >
        <MinusIcon className="size-4" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={`Số câu ${label}`}
        value={String(value)}
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const raw = event.target.value.replace(/\D/g, "");
          update(raw === "" ? 0 : Number(raw));
        }}
        className="h-full w-full border-0 bg-background text-center text-base font-bold tabular-nums outline-none disabled:opacity-50"
      />
      <button
        type="button"
        aria-label={`Tăng ${label}`}
        className="flex items-center justify-center border-l border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        onClick={(event) => {
          event.stopPropagation();
          update(value + 1);
        }}
        disabled={disabled || value >= max}
      >
        <PlusIcon className="size-4" />
      </button>
    </div>
  );
}

interface KindQuantityGridProps {
  value: KindQuantities;
  onChange: (next: KindQuantities) => void;
  disabled?: boolean;
  max?: number;
  helperText?: string;
  totalLabel?: (total: number) => string;
}

export function KindQuantityGrid({
  value,
  onChange,
  disabled,
  max = 8,
  helperText = "Áp dụng cho mỗi phân đoạn khi tạo bài tập toàn bài.",
  totalLabel = (total) => `${total} câu / phân đoạn`,
}: KindQuantityGridProps) {
  const total = totalQuantity(value);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Số lượng theo loại</p>
          <p className="text-xs text-muted-foreground">{helperText}</p>
        </div>
        <span className="inline-flex h-8 items-center rounded-full bg-primary/10 px-3 text-sm font-bold text-primary">
          {totalLabel(total)}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {KIND_OPTIONS.map(({ kind, label, shortLabel, description }) => {
          const count = value[kind] ?? 0;
          const style = KIND_STYLE[kind];
          return (
            <div
              key={kind}
              className={`relative flex min-h-[82px] flex-col items-stretch justify-between gap-3 overflow-hidden rounded-xl border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:gap-4 ${
                count > 0
                  ? `${style.active} shadow-sm`
                  : style.idle
              }`}
            >
              <div className={`absolute inset-y-0 left-0 w-1 ${count > 0 ? style.rail : "bg-border"}`} />
              <div className="flex min-w-0 items-start gap-3 pl-1">
                <span className={`mt-1 size-2.5 shrink-0 rounded-full ${style.dot}`} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold leading-tight">{label}</span>
                    <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${style.badge}`}>
                      {shortLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-snug text-muted-foreground">{description}</p>
                </div>
              </div>
              <div className="self-end sm:self-auto">
                <Stepper
                  value={count}
                  onChange={(n) => onChange({ ...value, [kind]: n })}
                  label={label}
                  min={0}
                  max={max}
                  disabled={disabled}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
