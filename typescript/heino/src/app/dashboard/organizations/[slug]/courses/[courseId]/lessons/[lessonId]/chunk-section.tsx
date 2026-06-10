"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronRightIcon, ChevronDownIcon, SparklesIcon, PlusIcon, MoreHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { GenerationStrategy } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { InteractionRow, type InteractionFormData } from "./interaction-row";
import { ChunkGenerateForm, type ChunkGenPhase } from "./chunk-generate-form";
import { ChunkAddForm } from "./chunk-add-form";

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
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
  onDeleteAllInChunk: () => void;
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
  onDeleteAllInChunk,
  onUpdate, onDelete,
}: ChunkSectionProps) {
  const openGenerate = () => {
    if (!expanded) onToggle();
    onOpenGenerate();
  };
  const openAdd = () => {
    if (!expanded) onToggle();
    onOpenAdd();
  };

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-background shadow-sm hover:shadow-md transition-shadow">
      {/* Title bar */}
      <div
        data-testid="chunk-title-bar"
        className="flex items-center gap-3 px-5 py-4 hover:bg-muted/20 cursor-pointer select-none transition-colors"
        onClick={onToggle}
      >
        {expanded
          ? <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          : <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{chunk.summary}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground font-mono">
              {formatTime(chunk.startSeconds)}–{formatTime(chunk.endSeconds)}
            </span>
            <span className={`text-xs font-medium ${interactions.length > 0 ? "text-foreground" : "text-muted-foreground"}`}>
              {interactions.length > 0
                ? `${interactions.length} bài tập`
                : "Chưa có bài tập"}
            </span>
          </div>
        </div>

        {/* Primary actions */}
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2.5"
            disabled={disabled || chunkGen?.phase === "running"}
            onClick={openGenerate}
          >
            <SparklesIcon className="size-3.5" />
            AI
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2.5"
            disabled={disabled}
            onClick={openAdd}
            data-testid="add-interaction-btn"
          >
            <PlusIcon className="size-3.5" />
            Thêm
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0 rounded-lg"
                disabled={disabled}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl">
              <DropdownMenuItem
                disabled={disabled || chunkGen?.phase === "running"}
                onSelect={openGenerate}
                className="rounded-lg"
              >
                <SparklesIcon className="size-4 mr-2" />
                Tạo bài tập AI
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={disabled}
                onSelect={openAdd}
                className="rounded-lg"
              >
                <PlusIcon className="size-4 mr-2" />
                Thêm thủ công
              </DropdownMenuItem>
              {interactions.length > 0 && (
                <DropdownMenuItem
                  disabled={disabled || chunkGen?.phase === "running"}
                  onSelect={() => onDeleteAllInChunk()}
                  className="rounded-lg text-destructive focus:text-destructive"
                >
                  <Trash2Icon className="size-4 mr-2" />
                  Xóa bài tập phân đoạn
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="flex flex-col gap-3 px-5 pb-5 pt-2 border-t border-border">
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
            <div className="flex flex-col items-center gap-2 py-6 rounded-lg border border-dashed border-muted-foreground/20 bg-muted/10">
              <p className="text-sm text-muted-foreground">Phân đoạn này chưa có bài tập</p>
              <p className="text-xs text-muted-foreground/70">Đang chờ nội dung bài tập.</p>
            </div>
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
