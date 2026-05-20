"use client";

import { useState } from "react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { InteractionForm, type InteractionFormData, emptyFormForKind } from "./interaction-row";

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
] as const;

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

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
  const [kind, setKind] = useState<InteractionKind>(InteractionKind.MCQ);

  return (
    <div className="rounded-md border border-border bg-background p-2 flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">
        ➕ Thêm bài tập — {formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}
      </p>
      <div className="flex gap-1 flex-wrap">
        {KIND_OPTIONS.map(({ kind: k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={[
              "text-xs px-2.5 py-1 rounded-md border transition-colors",
              kind === k
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:border-foreground/50",
            ].join(" ")}
          >
            {label}
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
