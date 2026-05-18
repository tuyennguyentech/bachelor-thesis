"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  ChevronRightIcon, ChevronDownIcon, PlusIcon, Loader2Icon, SettingsIcon, SparklesIcon,
} from "lucide-react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";
import {
  InteractionRow, InteractionForm,
  emptyFormForKind, buildProtoConfig,
} from "./interaction-row";
import { ChunkConfigModal } from "./chunk-config-modal";
import { ChunkGenerateConfirmModal } from "./generate-confirm-modal";

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const KIND_LABELS: Record<number, string> = {
  [InteractionKind.MCQ]: "Trắc nghiệm",
  [InteractionKind.FILL_BLANK]: "Điền đáp án",
  [InteractionKind.LISTENING]: "Bài nghe",
  [InteractionKind.READING]: "Bài đọc",
};

const ADDABLE_KINDS: InteractionKind[] = [
  InteractionKind.MCQ,
  InteractionKind.FILL_BLANK,
  InteractionKind.LISTENING,
  InteractionKind.READING,
];

interface Props {
  chunk: TranscriptChunk;
  chunkInteractions: LessonInteraction[];
  lessonId: string;
  token: string;
  disabled: boolean;
  defaultOpen?: boolean;
  onInteractionUpdate: (it: LessonInteraction) => void;
  onInteractionDelete: (id: string) => void;
  onInteractionAdd: (it: LessonInteraction) => void;
  onGenerateChunk: (chunkId: string, force: boolean) => void;
}

export function ChunkInteractionsCard({
  chunk: initialChunk, chunkInteractions, lessonId, token, disabled, defaultOpen = true,
  onInteractionUpdate, onInteractionDelete, onInteractionAdd, onGenerateChunk,
}: Props) {
  const interactionClient = useRichterWebClient(InteractionService, token);
  const [chunk, setChunk] = useState(initialChunk);
  const [open, setOpen] = useState(defaultOpen);
  const [addingKind, setAddingKind] = useState<InteractionKind | null>(null);
  const [showKindPicker, setShowKindPicker] = useState(false);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [generateConfirmOpen, setGenerateConfirmOpen] = useState(false);
  const [pendingGenerateAfterConfig, setPendingGenerateAfterConfig] = useState(false);

  function handleAdd(data: ReturnType<typeof emptyFormForKind>) {
    setAddError(null);
    startAddSave(async () => {
      try {
        const res = await interactionClient.createManualInteraction({
          lessonId,
          chunkId: chunk.id,
          prompt: data.prompt,
          explanation: data.explanation,
          startSeconds: data.startSeconds,
          config: buildProtoConfig(data),
        });
        if (res.interaction) {
          onInteractionAdd(res.interaction);
          setAddingKind(null);
          setShowKindPicker(false);
        }
      } catch (err) {
        setAddError(err instanceof ConnectError ? err.message : "Không thể thêm câu hỏi");
      }
    });
  }

  function handleClickGenerate() {
    if (!chunk.interactionConfig) {
      // no config yet — open config modal first, then generate after save
      setPendingGenerateAfterConfig(true);
      setConfigOpen(true);
    } else {
      setGenerateConfirmOpen(true);
    }
  }

  function handleConfigSaved(updated: TranscriptChunk) {
    setChunk(updated);
    if (pendingGenerateAfterConfig) {
      setPendingGenerateAfterConfig(false);
      setGenerateConfirmOpen(true);
    }
  }

  const interactionCount = chunkInteractions.length;

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          onClick={() => setOpen(o => !o)}
        >
          {open
            ? <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{chunk.summary}</p>
            <p className="text-xs text-muted-foreground">
              {formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}
              <span className="ml-2">{interactionCount > 0 ? `${interactionCount} bài tập` : "Chưa có bài tập"}</span>
            </p>
          </div>
        </button>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost" size="sm" className="size-6 p-0" title="Cấu hình bài tập cho phân đoạn này"
            disabled={disabled}
            onClick={() => { setPendingGenerateAfterConfig(false); setConfigOpen(true); }}
          >
            <SettingsIcon className="size-3" />
          </Button>
          <Button
            variant="ghost" size="sm" className="size-6 p-0" title="Tạo bài tập bằng AI"
            disabled={disabled}
            onClick={handleClickGenerate}
          >
            <SparklesIcon className="size-3" />
          </Button>
          <Button
            variant="ghost" size="sm" className="size-6 p-0" title="Thêm bài tập thủ công"
            disabled={disabled}
            onClick={() => { setOpen(true); setShowKindPicker(true); }}
          >
            <PlusIcon className="size-3" />
          </Button>
        </div>
      </div>

      {/* Card body */}
      {open && (
        <div className="flex flex-col gap-2 p-2">
          {chunkInteractions.length === 0 && addingKind === null && !showKindPicker && (
            <p className="text-xs text-muted-foreground px-1 py-1">Chưa có bài tập nào.</p>
          )}

          {chunkInteractions.map((it, i) => (
            <InteractionRow
              key={it.id}
              interaction={it}
              index={i}
              lessonId={lessonId}
              token={token}
              disabled={disabled}
              onUpdate={onInteractionUpdate}
              onDelete={onInteractionDelete}
            />
          ))}

          {addingKind !== null ? (
            <InteractionForm
              initial={emptyFormForKind(addingKind)}
              onSave={handleAdd}
              onCancel={() => { setAddingKind(null); setAddError(null); }}
              saving={addSaving}
              error={addError}
              lessonId={lessonId}
              token={token}
            />
          ) : showKindPicker ? (
            <div className="flex flex-col gap-1 p-2 rounded-md border border-border bg-muted/30">
              <p className="text-xs text-muted-foreground px-1">Chọn loại bài tập:</p>
              {ADDABLE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="text-left text-sm px-3 py-2 rounded hover:bg-muted transition-colors"
                  onClick={() => { setShowKindPicker(false); setAddingKind(kind); }}
                >
                  {KIND_LABELS[kind]}
                </button>
              ))}
              <Button variant="ghost" size="sm" className="self-start mt-1" onClick={() => setShowKindPicker(false)}>
                Hủy
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost" size="sm" className="gap-1.5 self-start text-muted-foreground h-7"
              disabled={disabled}
              onClick={() => setShowKindPicker(true)}
              data-testid="add-interaction-btn"
            >
              <PlusIcon className="size-3" />
              Thêm bài tập
            </Button>
          )}
        </div>
      )}

      {/* Modals */}
      <ChunkConfigModal
        open={configOpen}
        onClose={() => { setConfigOpen(false); setPendingGenerateAfterConfig(false); }}
        chunk={chunk}
        token={token}
        onSaved={handleConfigSaved}
      />
      <ChunkGenerateConfirmModal
        open={generateConfirmOpen}
        onClose={() => setGenerateConfirmOpen(false)}
        chunk={chunk}
        existingCount={interactionCount}
        onConfirm={(force) => onGenerateChunk(chunk.id, force)}
        onOpenConfig={() => { setGenerateConfirmOpen(false); setConfigOpen(true); }}
      />
    </div>
  );
}
