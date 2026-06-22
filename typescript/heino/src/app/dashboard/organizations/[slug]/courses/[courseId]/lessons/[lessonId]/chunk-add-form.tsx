"use client";

import { useState } from "react";
import {
  CircleDotIcon,
  ListChecksIcon,
  TextCursorInputIcon,
  BookOpenIcon,
  HeadphonesIcon,
  PenLineIcon,
  type LucideIcon,
} from "lucide-react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { InteractionForm, type InteractionFormData, emptyFormForKind } from "./interaction-row";

// Each exercise type carries an icon + plain-language name + one-line "what it does"
// so the teacher picks by intent, not by jargon (no more "MCQ1 / MCQ+").
const KIND_OPTIONS: ReadonlyArray<{
  kind: InteractionKind;
  label: string;
  hint: string;
  Icon: LucideIcon;
}> = [
  // Titles match the canonical per-kind labels (also shown in the interaction list);
  // the one-line hint + icon are the redesign's added clarity.
  { kind: InteractionKind.SINGLE_CHOICE, label: "Trắc nghiệm 1 đáp án", hint: "Học viên chọn một phương án", Icon: CircleDotIcon },
  { kind: InteractionKind.MULTIPLE_CHOICE, label: "Trắc nghiệm chọn nhiều", hint: "Chọn mọi phương án đúng", Icon: ListChecksIcon },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án", hint: "Gõ đáp án vào ô trống", Icon: TextCursorInputIcon },
  { kind: InteractionKind.READING, label: "Bài đọc", hint: "Đọc đoạn văn & trả lời", Icon: BookOpenIcon },
  { kind: InteractionKind.LISTENING, label: "Bài nghe", hint: "Nghe câu hỏi & chọn đáp án", Icon: HeadphonesIcon },
  { kind: InteractionKind.WRITING, label: "Bài viết", hint: "Viết đoạn văn theo đề", Icon: PenLineIcon },
];

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
    <div data-testid="chunk-add-form" className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Step 1 — pick a type */}
      <div className="flex flex-col gap-3 border-b border-border bg-muted/20 p-4">
        <div className="flex items-baseline gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">1</span>
          <p className="text-sm font-semibold tracking-tight">Chọn loại bài tập</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {KIND_OPTIONS.map(({ kind: k, label, hint, Icon }) => {
            const active = kind === k;
            return (
              <button
                key={k}
                type="button"
                aria-label={label}
                aria-pressed={active}
                data-testid={`interaction-kind-${k}`}
                onClick={() => setKind(k)}
                className={[
                  "group flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  active
                    ? "border-primary bg-primary/10 shadow-sm"
                    : "border-border bg-background hover:border-primary/40 hover:bg-muted/40",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                    active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-foreground",
                  ].join(" ")}
                >
                  <Icon className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={`text-xs font-semibold leading-tight ${active ? "text-primary" : "text-foreground"}`}>{label}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground">{hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2 — fill in the details (InteractionForm renders the per-type editor) */}
      <InteractionForm
        key={kind}
        initial={{ ...emptyFormForKind(kind), startSeconds: chunk.startSeconds }}
        onSave={onSave}
        onCancel={onCancel}
        saving={saving}
        error={error}
        lessonId={lessonId}
        token={token}
        flush
        stepLabel="2"
      />
    </div>
  );
}
