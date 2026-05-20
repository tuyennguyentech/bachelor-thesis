"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SparklesIcon, Loader2Icon } from "lucide-react";
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
          <KindQuantityGrid
            value={quantities}
            onChange={setQuantities}
            disabled={disabled}
          />

          {chunkInteractionsCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              ⚠ {chunkInteractionsCount} bài hiện có sẽ bị thay thế
            </p>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              className="gap-1"
              disabled={disabled || total === 0}
              onClick={handleGenerate}
            >
              <SparklesIcon className="size-3" />
              Tạo {total} câu
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
