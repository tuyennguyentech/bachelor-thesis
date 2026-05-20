"use client";

import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";

export const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm", icon: "📝" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án", icon: "✏️" },
  { kind: InteractionKind.READING, label: "Bài đọc", icon: "📖" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe", icon: "🎧" },
] as const;

export type KindQuantities = {
  [InteractionKind.MCQ]: number;
  [InteractionKind.FILL_BLANK]: number;
  [InteractionKind.READING]: number;
  [InteractionKind.LISTENING]: number;
};

export function emptyQuantities(): KindQuantities {
  return {
    [InteractionKind.MCQ]: 0,
    [InteractionKind.FILL_BLANK]: 0,
    [InteractionKind.READING]: 0,
    [InteractionKind.LISTENING]: 0,
  };
}

const KNOWN_KINDS = [InteractionKind.MCQ, InteractionKind.FILL_BLANK, InteractionKind.READING, InteractionKind.LISTENING] as const;

export function fromConfig(cfg: ChunkInteractionConfig | undefined): KindQuantities {
  const result = emptyQuantities();
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
  min?: number;
  max?: number;
  disabled?: boolean;
}

function Stepper({ value, onChange, min = 0, max = 8, disabled }: StepperProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="size-6 rounded border border-input flex items-center justify-center text-xs hover:bg-muted disabled:opacity-50"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={disabled || value <= min}
      >
        −
      </button>
      <span className="w-6 text-center text-sm font-medium">{value}</span>
      <button
        type="button"
        className="size-6 rounded border border-input flex items-center justify-center text-xs hover:bg-muted disabled:opacity-50"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={disabled || value >= max}
      >
        +
      </button>
    </div>
  );
}

interface KindQuantityGridProps {
  value: KindQuantities;
  onChange: (next: KindQuantities) => void;
  disabled?: boolean;
  max?: number;
}

export function KindQuantityGrid({ value, onChange, disabled, max = 8 }: KindQuantityGridProps) {
  const total = totalQuantity(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Số lượng theo loại:</p>
        <p className="text-xs font-medium">Tổng: {total} câu</p>
      </div>
      <div className="rounded border border-border p-2 flex flex-col gap-1">
        {KIND_OPTIONS.map(({ kind, label, icon }) => (
          <div key={kind} className="flex items-center justify-between py-1">
            <span className="text-sm">{icon} {label}</span>
            <Stepper
              value={value[kind] ?? 0}
              onChange={(n) => onChange({ ...value, [kind]: n })}
              min={0}
              max={max}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
