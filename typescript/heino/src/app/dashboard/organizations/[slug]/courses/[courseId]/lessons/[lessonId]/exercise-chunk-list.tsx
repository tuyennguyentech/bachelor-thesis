"use client";

import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import type { GenerationStrategy } from "buf/gen/richter/v1/ai_pb";
import type { InteractionKind, LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { ChunkSection } from "./chunk-section";
import type { ChunkGenPhase } from "./chunk-generate-form";
import { InteractionRow, type InteractionFormData } from "./interaction-row";

interface ExerciseChunkListProps {
  addError: string | null;
  addSaving: boolean;
  addingChunkId: string | null;
  chunkGenState: Record<string, ChunkGenPhase>;
  disabled: boolean;
  expandedChunks: Set<string>;
  filteredChunks: TranscriptChunk[];
  interactions: LessonInteraction[];
  isAddingDisabled: boolean;
  lessonId: string;
  localChunks: TranscriptChunk[];
  onCloseAdd: () => void;
  onCloseGenerate: (chunkId: string) => void;
  onDelete: (id: string) => void;
  onDeleteAllInChunk: (chunkId: string) => void;
  onGenerate: (chunkId: string, count: number, kinds: InteractionKind[], strategy: GenerationStrategy) => void;
  onOpenAdd: (chunkId: string) => void;
  onOpenGenerate: (chunkId: string) => void;
  onSaveAdd: (chunkId: string, data: InteractionFormData) => void;
  onToggleChunk: (chunkId: string) => void;
  onUpdate: (interaction: LessonInteraction) => void;
  openGenerateChunkIds: Set<string>;
  token: string;
}

export function ExerciseChunkList({
  addError,
  addSaving,
  addingChunkId,
  chunkGenState,
  disabled,
  expandedChunks,
  filteredChunks,
  interactions,
  isAddingDisabled,
  lessonId,
  localChunks,
  onCloseAdd,
  onCloseGenerate,
  onDelete,
  onDeleteAllInChunk,
  onGenerate,
  onOpenAdd,
  onOpenGenerate,
  onSaveAdd,
  onToggleChunk,
  onUpdate,
  openGenerateChunkIds,
  token,
}: ExerciseChunkListProps) {
  const orphans = interactions.filter(
    (it) => !it.chunkId || !localChunks.some((c) => c.id === it.chunkId),
  );

  return (
    <div className="flex flex-col gap-3">
      {filteredChunks.map((chunk) => (
        <ChunkSection
          key={chunk.id}
          chunk={chunk}
          interactions={interactions.filter(it => it.chunkId === chunk.id)}
          expanded={expandedChunks.has(chunk.id)}
          onToggle={() => onToggleChunk(chunk.id)}
          isGenerating={openGenerateChunkIds.has(chunk.id) || chunkGenState[chunk.id]?.phase === "running"}
          isAdding={addingChunkId === chunk.id}
          chunkGen={chunkGenState[chunk.id]}
          lessonId={lessonId}
          token={token}
          disabled={isAddingDisabled}
          addSaving={addSaving}
          addError={addError}
          onOpenGenerate={() => onOpenGenerate(chunk.id)}
          onCloseGenerate={() => onCloseGenerate(chunk.id)}
          onGenerate={(count, kinds, strategy) => onGenerate(chunk.id, count, kinds, strategy)}
          onOpenAdd={() => onOpenAdd(chunk.id)}
          onCloseAdd={onCloseAdd}
          onSaveAdd={(data) => onSaveAdd(chunk.id, data)}
          onDeleteAllInChunk={() => onDeleteAllInChunk(chunk.id)}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}

      {filteredChunks.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-6">
          Không tìm thấy phân đoạn nào phù hợp.
        </p>
      )}

      {orphans.length > 0 && (
        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="text-sm text-muted-foreground mb-3">
            Bài tập không thuộc phân đoạn nào ({orphans.length})
          </p>
          <div className="flex flex-col gap-2">
            {orphans.map((it, i) => (
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
          </div>
        </div>
      )}
    </div>
  );
}
