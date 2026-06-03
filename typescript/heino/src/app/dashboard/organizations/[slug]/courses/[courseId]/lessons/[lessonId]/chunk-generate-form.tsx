"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircleIcon, Loader2Icon, SparklesIcon, XCircleIcon } from "lucide-react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { GenerationStrategy } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { KindQuantityGrid, fromConfig, toKindsList, totalQuantity, type KindQuantities } from "./kind-quantity-grid";

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
  const [quantities, setQuantities] = useState<KindQuantities>(
    () => fromConfig(chunk.interactionConfig),
  );

  const total = totalQuantity(quantities);
  const isRunning = chunkGen?.phase === "running";
  const isDone = chunkGen?.phase === "done";
  const isError = chunkGen?.phase === "error";

  function handleGenerate() {
    if (total === 0) return;
    onGenerate(total, toKindsList(quantities), GenerationStrategy.EVEN_DISTRIBUTION);
  }

  return (
    <div className="rounded-xl border border-border bg-muted/10 p-4 flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <div className="rounded-lg bg-primary/10 p-1.5">
          <SparklesIcon className="size-4 text-primary" />
        </div>
        Tạo bài tập AI
      </p>

      {isRunning ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground rounded-lg bg-primary/5 px-3 py-2.5">
          <Loader2Icon className="size-4 animate-spin shrink-0 text-primary" />
          {chunkGen.message}
        </div>
      ) : isDone ? (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 rounded-lg bg-green-50 dark:bg-green-950/30 px-3 py-2.5">
          <CheckCircleIcon className="size-4" />
          Hoàn thành
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 text-sm text-destructive rounded-lg bg-destructive/5 px-3 py-2.5">
          <XCircleIcon className="size-4" />
          {chunkGen.message}
        </div>
      ) : (
        <>
          <KindQuantityGrid
            value={quantities}
            onChange={setQuantities}
            disabled={disabled}
            helperText="Áp dụng cho phân đoạn đang mở."
            totalLabel={(n) => `${n} câu`}
          />

          {chunkInteractionsCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400 rounded-lg bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
              {chunkInteractionsCount} bài hiện có sẽ được giữ lại; câu mới sẽ được thêm vào cuối.
            </p>
          )}

          <div className="flex gap-2">
            <Button
              className="gap-2 rounded-xl"
              disabled={disabled || total === 0}
              onClick={handleGenerate}
            >
              <SparklesIcon className="size-4" />
              Tạo {total} câu hỏi
            </Button>
            <Button variant="ghost" onClick={onClose} className="rounded-xl">
              Hủy
            </Button>
          </div>
        </>
      )}

      {(isDone || isError) && (
        <Button variant="ghost" className="self-start rounded-xl" onClick={onClose}>
          Đóng
        </Button>
      )}
    </div>
  );
}
