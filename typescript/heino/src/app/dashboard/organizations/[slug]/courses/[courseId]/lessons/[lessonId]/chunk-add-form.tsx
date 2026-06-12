"use client";

import { useState } from "react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { InteractionForm, type InteractionFormData, emptyFormForKind } from "./interaction-row";

const KIND_OPTIONS = [
  { kind: InteractionKind.SINGLE_CHOICE, label: "Trắc nghiệm 1 đáp án", shortLabel: "MCQ1" },
  { kind: InteractionKind.MULTIPLE_CHOICE, label: "Trắc nghiệm chọn nhiều", shortLabel: "MCQ+" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án", shortLabel: "Điền" },
  { kind: InteractionKind.READING, label: "Bài đọc", shortLabel: "Đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe", shortLabel: "Nghe" },
  { kind: InteractionKind.WRITING, label: "Bài viết", shortLabel: "Viết" },
] as const;

interface ChunkAddFormProps {
  chunk: TranscriptChunk;
  lessonId: string;
  token: string;
  saving: boolean;
  error: string | null;
  onSave: (data: InteractionFormData) => void;
  onCancel: () => void;
}

export function ChunkAddForm({ chunk, lessonId, token, saving, error, onSave, onCancel }: ChunkAddFormProps) {
  const [kind, setKind] = useState<InteractionKind>(InteractionKind.SINGLE_CHOICE);

  return (
    <div data-testid="chunk-add-form" className="rounded-xl border border-border bg-muted/10 p-4 flex flex-col gap-4">
      <p className="text-sm font-medium">
        Thêm bài tập thủ công
      </p>
      <div className="flex gap-2 flex-wrap">
        {KIND_OPTIONS.map(({ kind: k, label, shortLabel }) => (
          <button
            key={k}
            type="button"
            aria-label={label}
            data-testid={`interaction-kind-${k}`}
            onClick={() => setKind(k)}
            className={[
              "flex flex-col items-center gap-0.5 text-xs px-3 py-2 rounded-xl border-2 transition-all",
              kind === k
                ? "border-primary bg-primary/10 text-primary font-semibold shadow-sm"
                : "border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50",
            ].join(" ")}
          >
            <span className="font-bold">{shortLabel}</span>
            <span className="text-[10px] opacity-70">{label}</span>
          </button>
        ))}
      </div>
      <InteractionForm
        key={kind}
        initial={{ ...emptyFormForKind(kind), startSeconds: chunk.startSeconds }}
        onSave={onSave}
        onCancel={onCancel}
        saving={saving}
        error={error}
        lessonId={lessonId}
        token={token}
      />
    </div>
  );
}
