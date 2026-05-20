"use client";

import { Button } from "@/components/ui/button";
import { ChevronRightIcon, ChevronDownIcon, SparklesIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { GenerationStrategy } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { InteractionRow, KIND_BADGE_CLS, type InteractionFormData } from "./interaction-row";
import { ChunkGenerateForm, type ChunkGenPhase } from "./chunk-generate-form";
import { ChunkAddForm } from "./chunk-add-form";

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const KIND_SHORT: Partial<Record<InteractionKind, string>> = {
  [InteractionKind.MCQ]: "MCQ",
  [InteractionKind.FILL_BLANK]: "Fill",
  [InteractionKind.READING]: "Đọc",
  [InteractionKind.LISTENING]: "Nghe",
};

function ChunkSummaryChip({ interactions }: { interactions: LessonInteraction[] }) {
  if (interactions.length === 0) {
    return <span className="text-xs text-muted-foreground">Chưa có bài tập</span>;
  }
  const byKind = interactions.reduce<Partial<Record<InteractionKind, number>>>((acc, i) => {
    acc[i.kind] = (acc[i.kind] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <span className="text-xs flex items-center gap-1">
      <span className="text-muted-foreground">{interactions.length} bài tập</span>
      <span className="flex gap-0.5">
        {(Object.entries(byKind) as [string, number][]).map(([kind, count]) => (
          <span
            key={kind}
            className={cn("rounded px-1 py-px text-xs font-medium", KIND_BADGE_CLS[Number(kind) as InteractionKind])}
          >
            {KIND_SHORT[Number(kind) as InteractionKind]}{count > 1 ? `×${count}` : ""}
          </span>
        ))}
      </span>
    </span>
  );
}

interface ChunkSectionProps {
  chunk: TranscriptChunk;
  interactions: LessonInteraction[];
  expanded: boolean;
  onToggle: () => void;
  isGenerating: boolean;
  isAdding: boolean;
  chunkGen: ChunkGenPhase | undefined;
  lessonId: string;
  token: string;
  disabled: boolean;
  addSaving: boolean;
  addError: string | null;
  onOpenGenerate: () => void;
  onCloseGenerate: () => void;
  onGenerate: (count: number, kinds: InteractionKind[], strategy: GenerationStrategy) => void;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
  onSaveAdd: (data: InteractionFormData) => void;
  onUpdate: (updated: LessonInteraction) => void;
  onDelete: (id: string) => void;
}

export function ChunkSection({
  chunk, interactions, expanded, onToggle,
  isGenerating, isAdding, chunkGen,
  lessonId, token, disabled,
  addSaving, addError,
  onOpenGenerate, onCloseGenerate, onGenerate,
  onOpenAdd, onCloseAdd, onSaveAdd,
  onUpdate, onDelete,
}: ChunkSectionProps) {
  const hasCustomConfig = !!chunk.interactionConfig;

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {/* Title bar — always visible */}
      <div
        data-testid="chunk-title-bar"
        className="flex items-center gap-2 px-3 py-2 bg-muted/30 cursor-pointer select-none"
        onClick={onToggle}
      >
        {expanded
          ? <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{chunk.summary}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground shrink-0">
              {formatTime(chunk.startSeconds)}–{formatTime(chunk.endSeconds)}
            </span>
            <ChunkSummaryChip interactions={interactions} />
            {hasCustomConfig && (
              <span
                className="text-xs border border-border rounded px-1 py-px text-muted-foreground"
                title={`Cấu hình riêng: ${chunk.interactionConfig!.count} bài, ${chunk.interactionConfig!.kinds.map(k => KIND_SHORT[k]).filter(Boolean).join(" + ")}`}
              >
                ⚙
              </span>
            )}
          </div>
        </div>

        {/* Action buttons — stop propagation so clicking them doesn't toggle expand */}
        <div
          className="flex items-center gap-0.5 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="size-6 p-0"
            title={isGenerating ? "Đóng form tạo AI" : "Tạo bài tập bằng AI"}
            disabled={disabled || chunkGen?.phase === "running"}
            onClick={() => {
              if (isGenerating) onCloseGenerate();
              else onOpenGenerate();
            }}
          >
            <SparklesIcon className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-6 p-0"
            title={isAdding ? "Đóng form thêm" : "Thêm bài tập thủ công"}
            disabled={disabled}
            onClick={() => {
              if (isAdding) onCloseAdd();
              else onOpenAdd();
            }}
            data-testid="add-interaction-btn"
          >
            <PlusIcon className="size-3" />
          </Button>
        </div>
      </div>

      {/* Body — only rendered when expanded */}
      {expanded && (
        <div className="flex flex-col gap-2 p-2">
          {isGenerating && (
            <ChunkGenerateForm
              chunk={chunk}
              chunkInteractionsCount={interactions.length}
              disabled={disabled}
              chunkGen={chunkGen}
              onGenerate={onGenerate}
              onClose={onCloseGenerate}
            />
          )}

          {interactions.length === 0 && !isAdding && !isGenerating && (
            <p className="text-xs text-muted-foreground px-1 py-1">Chưa có bài tập nào.</p>
          )}

          {interactions.map((it, i) => (
            <InteractionRow
              key={it.id}
              interaction={it}
              index={i}
              lessonId={lessonId}
              token={token}
              disabled={disabled}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}

          {isAdding && (
            <ChunkAddForm
              chunk={chunk}
              lessonId={lessonId}
              token={token}
              saving={addSaving}
              error={addError}
              onSave={onSaveAdd}
              onCancel={onCloseAdd}
            />
          )}
        </div>
      )}
    </div>
  );
}
