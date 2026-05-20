"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { SparklesIcon, Loader2Icon } from "lucide-react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { GenerationStrategy } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
] as const;

export type ChunkGenPhase =
  | { phase: "idle" }
  | { phase: "running"; message: string }
  | { phase: "done" }
  | { phase: "error"; message: string };

interface ChunkGenerateFormProps {
  chunk: TranscriptChunk;
  chunkInteractionsCount: number;
  disabled: boolean;
  chunkGen: ChunkGenPhase | undefined;
  onGenerate: (count: number, kinds: InteractionKind[], strategy: GenerationStrategy) => void;
  onClose: () => void;
}

export function ChunkGenerateForm({
  chunk, chunkInteractionsCount, disabled, chunkGen, onGenerate, onClose,
}: ChunkGenerateFormProps) {
  const initCfg = chunk.interactionConfig;
  const [count, setCount] = useState(initCfg?.count ?? 2);
  const [kinds, setKinds] = useState<InteractionKind[]>(
    initCfg?.kinds?.length ? [...initCfg.kinds] : [InteractionKind.MCQ],
  );
  const [strategy, setStrategy] = useState<GenerationStrategy>(
    initCfg?.strategy ?? GenerationStrategy.AI_CHOOSE,
  );
  const [countManuallyEdited, setCountManuallyEdited] = useState(false);

  function handleStrategyChange(s: GenerationStrategy) {
    setStrategy(s);
    if (s === GenerationStrategy.EVEN_DISTRIBUTION && !countManuallyEdited && kinds.length > count) {
      setCount(kinds.length);
    }
  }

  function handleKindToggle(kind: InteractionKind) {
    setKinds(prev => {
      const next = prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind];
      if (strategy === GenerationStrategy.EVEN_DISTRIBUTION && !countManuallyEdited) {
        setCount(Math.max(1, next.length));
      }
      return next;
    });
  }

  function handleBulkToggle() {
    const allSelected = kinds.length === KIND_OPTIONS.length;
    const next = allSelected ? [] : KIND_OPTIONS.map(o => o.kind);
    setKinds(next);
    if (strategy === GenerationStrategy.EVEN_DISTRIBUTION && !countManuallyEdited) {
      setCount(Math.max(1, next.length));
    }
  }

  const preview = useMemo(() => {
    if (kinds.length === 0) return null;
    const kindLabels = kinds
      .map(k => KIND_OPTIONS.find(o => o.kind === k)?.label ?? "")
      .filter(Boolean)
      .join(", ");
    if (strategy === GenerationStrategy.AI_CHOOSE) {
      return `Sẽ tạo: ${count} câu. AI chọn 1 trong [${kindLabels}] cho mỗi câu.`;
    }
    if (count < kinds.length) {
      return `⚠ Số lượng (${count}) < số loại (${kinds.length}). Chỉ ${count} loại đầu được dùng.`;
    }
    const perKind = Math.floor(count / kinds.length);
    if (count % kinds.length === 0) {
      return `Sẽ tạo: ${perKind} câu mỗi loại = ${count} câu.`;
    }
    return `Sẽ tạo: ${count} câu, phân bổ giữa [${kindLabels}].`;
  }, [count, kinds, strategy]);

  const isRunning = chunkGen?.phase === "running";
  const isDone = chunkGen?.phase === "done";
  const isError = chunkGen?.phase === "error";

  return (
    <div className="rounded-md border border-border bg-background p-3 flex flex-col gap-2">
      <p className="text-xs font-medium">🤖 Tạo bài tập AI — {chunk.summary}</p>

      {isRunning ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2Icon className="size-3 animate-spin shrink-0" />
          {chunkGen.message}
        </p>
      ) : isDone ? (
        <p className="text-xs text-green-700 dark:text-green-400">✅ Hoàn thành</p>
      ) : isError ? (
        <p className="text-xs text-destructive">❌ {chunkGen.message}</p>
      ) : (
        <>
          {/* Count stepper */}
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground shrink-0">Số lượng:</label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="size-6 rounded border border-input flex items-center justify-center text-xs hover:bg-muted disabled:opacity-50"
                onClick={() => { setCount(c => Math.max(1, c - 1)); setCountManuallyEdited(true); }}
                disabled={count <= 1}
              >−</button>
              <span className="w-8 text-center text-sm font-medium">{count}</span>
              <button
                type="button"
                className="size-6 rounded border border-input flex items-center justify-center text-xs hover:bg-muted disabled:opacity-50"
                onClick={() => { setCount(c => Math.min(8, c + 1)); setCountManuallyEdited(true); }}
                disabled={count >= 8}
              >+</button>
            </div>
          </div>

          {/* Kinds */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">Loại:</p>
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={handleBulkToggle}
              >
                {kinds.length === KIND_OPTIONS.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}
              </button>
            </div>
            <div className="flex flex-wrap gap-3">
              {KIND_OPTIONS.map(({ kind, label }) => (
                <label key={kind} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={kinds.includes(kind)}
                    onChange={() => handleKindToggle(kind)}
                  />
                  <span className="text-xs">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Strategy */}
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Chiến lược:</p>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name={`gen-strat-${chunk.id}`}
                  checked={strategy === GenerationStrategy.AI_CHOOSE}
                  onChange={() => handleStrategyChange(GenerationStrategy.AI_CHOOSE)}
                />
                <span className="text-xs">AI chọn loại phù hợp nhất theo nội dung</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name={`gen-strat-${chunk.id}`}
                  checked={strategy === GenerationStrategy.EVEN_DISTRIBUTION}
                  onChange={() => handleStrategyChange(GenerationStrategy.EVEN_DISTRIBUTION)}
                />
                <span className="text-xs">Phân bổ đều theo thứ tự đã chọn</span>
              </label>
            </div>
          </div>

          {/* Live preview */}
          {preview && (
            <div className="rounded border border-border bg-muted/30 px-2.5 py-2 flex flex-col gap-0.5">
              <p className="text-xs text-muted-foreground">📋 {preview}</p>
              {chunkInteractionsCount > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  ⚠ {chunkInteractionsCount} bài hiện có sẽ bị thay thế
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              className="gap-1"
              disabled={disabled || kinds.length === 0}
              onClick={() => onGenerate(count, kinds, strategy)}
            >
              <SparklesIcon className="size-3" />
              Tạo {count} câu
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>Hủy</Button>
          </div>
        </>
      )}

      {(isDone || isError) && (
        <Button size="sm" variant="ghost" className="self-start" onClick={onClose}>
          Đóng
        </Button>
      )}
    </div>
  );
}
