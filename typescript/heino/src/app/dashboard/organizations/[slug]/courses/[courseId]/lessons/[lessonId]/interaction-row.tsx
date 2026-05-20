"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  PencilIcon, Trash2Icon, CheckIcon, Loader2Icon, RefreshCwIcon,
} from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";
import { getRenderer, extractConfig } from "@/interactions/registry";
import type { McqConfig, FillBlankConfig, ListeningConfig, ReadingConfig } from "@/interactions/types";
import { RegenerateModal } from "./regenerate-modal";

// ── Kind badge utilities ───────────────────────────────────────────────────────

export const KIND_BADGE_CLS: Partial<Record<InteractionKind, string>> = {
  [InteractionKind.MCQ]: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400",
  [InteractionKind.FILL_BLANK]: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  [InteractionKind.LISTENING]: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  [InteractionKind.READING]: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400",
};

export const KIND_BORDER_L_CLS: Partial<Record<InteractionKind, string>> = {
  [InteractionKind.MCQ]: "border-l-rose-400",
  [InteractionKind.FILL_BLANK]: "border-l-emerald-400",
  [InteractionKind.LISTENING]: "border-l-amber-400",
  [InteractionKind.READING]: "border-l-sky-400",
};

// ── Form data ─────────────────────────────────────────────────────────────────

export interface InteractionFormData {
  kind: InteractionKind;
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  explanation: string;
  startSeconds: number;
}

export function emptyFormForKind(kind: InteractionKind): InteractionFormData {
  if (kind === InteractionKind.FILL_BLANK) {
    return {
      kind, prompt: "",
      config: { template: "", blanks: [] } satisfies FillBlankConfig,
      explanation: "", startSeconds: 0,
    };
  }
  if (kind === InteractionKind.LISTENING) {
    return {
      kind, prompt: "",
      config: { audioObjectKey: "", durationSeconds: 0, mode: "comprehension", expectedText: "", comprehensionQuestions: [] } satisfies ListeningConfig,
      explanation: "", startSeconds: 0,
    };
  }
  if (kind === InteractionKind.READING) {
    return {
      kind, prompt: "",
      config: { passageMarkdown: "", questions: [] } satisfies ReadingConfig,
      explanation: "", startSeconds: 0,
    };
  }
  return {
    kind: InteractionKind.MCQ, prompt: "",
    config: { options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }], correctAnswer: 0 } satisfies McqConfig,
    explanation: "", startSeconds: 0,
  };
}

export function formFromInteraction(it: LessonInteraction): InteractionFormData {
  return {
    kind: it.kind,
    prompt: it.prompt,
    config: extractConfig(it) ?? emptyFormForKind(it.kind).config,
    explanation: it.explanation,
    startSeconds: it.startSeconds,
  };
}

export function isSaveable(form: InteractionFormData): boolean {
  if (!form.prompt.trim()) return false;
  if (form.kind === InteractionKind.MCQ) {
    const c = form.config as McqConfig;
    return c.options?.every((o: { text: string }) => o.text.trim() !== "") ?? false;
  }
  if (form.kind === InteractionKind.FILL_BLANK) {
    const c = form.config as FillBlankConfig;
    return c.template?.trim() !== "" && c.blanks?.length > 0 && c.blanks.every((b) => b.accepted.length > 0);
  }
  if (form.kind === InteractionKind.LISTENING) {
    const c = form.config as ListeningConfig;
    if (!c.audioObjectKey) return false;
    if (c.mode === "dictation") return c.expectedText.trim() !== "";
    return c.comprehensionQuestions.length > 0;
  }
  if (form.kind === InteractionKind.READING) {
    const c = form.config as ReadingConfig;
    return c.passageMarkdown.trim() !== "" && c.questions.length > 0;
  }
  return false;
}

export function buildProtoConfig(form: InteractionFormData) {
  if (form.kind === InteractionKind.FILL_BLANK) {
    const c = form.config as FillBlankConfig;
    return {
      case: "fillBlank" as const,
      value: { template: c.template, blanks: c.blanks.map((b) => ({ accepted: b.accepted, caseSensitive: b.caseSensitive, hint: b.hint })) },
    };
  }
  if (form.kind === InteractionKind.LISTENING) {
    const c = form.config as ListeningConfig;
    return {
      case: "listening" as const,
      value: {
        audioObjectKey: c.audioObjectKey, durationSeconds: c.durationSeconds, mode: c.mode === "dictation" ? 1 : 2,
        expectedText: c.expectedText, comprehensionQuestions: c.comprehensionQuestions.map((q) => ({ options: q.options.map((o) => ({ text: o.text })), correctAnswer: q.correctAnswer })),
      },
    };
  }
  if (form.kind === InteractionKind.READING) {
    const c = form.config as ReadingConfig;
    return {
      case: "reading" as const,
      value: { passageMarkdown: c.passageMarkdown, questions: c.questions.map((q) => ({ options: q.options.map((o) => ({ text: o.text })), correctAnswer: q.correctAnswer })) },
    };
  }
  const c = form.config as McqConfig;
  return {
    case: "mcq" as const,
    value: { options: c.options.map((o) => ({ text: o.text })), correctAnswer: c.correctAnswer },
  };
}

// ── Interaction form ──────────────────────────────────────────────────────────

export interface InteractionFormProps {
  initial: InteractionFormData;
  onSave: (data: InteractionFormData) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  lessonId: string;
  token: string;
}

export function InteractionForm({ initial, onSave, onCancel, saving, error, lessonId, token }: InteractionFormProps) {
  const [form, setForm] = useState<InteractionFormData>(initial);

  let renderer;
  try { renderer = getRenderer(form.kind); }
  catch { return <p className="text-xs text-destructive">Loại câu hỏi không được hỗ trợ.</p>; }

  return (
    <div className="flex flex-col gap-3 p-3 bg-muted/30 rounded-md border border-border">
      <p className="text-xs font-medium text-muted-foreground">{renderer.label}</p>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          {form.kind === InteractionKind.FILL_BLANK ? "Câu dẫn (tuỳ chọn)" :
           form.kind === InteractionKind.LISTENING ? "Tiêu đề bài nghe" :
           form.kind === InteractionKind.READING ? "Tiêu đề bài đọc" : "Câu hỏi"}
        </label>
        <textarea
          rows={2}
          value={form.prompt}
          onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
          className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none"
          placeholder="Nhập câu hỏi..."
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1">
        {form.kind !== InteractionKind.LISTENING && form.kind !== InteractionKind.READING && (
          <label className="text-xs text-muted-foreground">
            {form.kind === InteractionKind.MCQ ? "Lựa chọn (click vòng tròn = đáp án đúng)" : "Template & chỗ trống"}
          </label>
        )}
        <renderer.EditorView
          config={form.config}
          onChange={(c) => setForm((f) => ({ ...f, config: c }))}
          lessonId={lessonId}
          token={token}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Giải thích đáp án</label>
          <input
            type="text"
            value={form.explanation}
            onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))}
            disabled={saving}
            placeholder="Không bắt buộc"
            className="text-sm rounded border border-input bg-background px-2 py-1"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Thời điểm (giây)</label>
          <input
            type="number" min={0} step={1}
            value={form.startSeconds}
            onChange={(e) => setForm((f) => ({ ...f, startSeconds: parseFloat(e.target.value) || 0 }))}
            disabled={saving}
            className="text-sm rounded border border-input bg-background px-2 py-1"
          />
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Hủy</Button>
        <Button size="sm" onClick={() => onSave(form)} disabled={saving || !isSaveable(form)} className="gap-1">
          {saving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
          Lưu
        </Button>
      </div>
    </div>
  );
}

// ── Interaction row ───────────────────────────────────────────────────────────

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

interface Props {
  interaction: LessonInteraction;
  index: number;
  lessonId: string;
  token: string;
  disabled: boolean;
  onUpdate: (it: LessonInteraction) => void;
  onDelete: (id: string) => void;
}

export function InteractionRow({ interaction: it, index, lessonId, token, disabled, onUpdate, onDelete }: Props) {
  const interactionClient = useRichterWebClient(InteractionService, token);
  const [editing, setEditing] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  let renderer;
  try { renderer = getRenderer(it.kind); } catch { renderer = null; }

  function handleSave(data: InteractionFormData) {
    setSaveError(null);
    startSave(async () => {
      try {
        const res = await interactionClient.updateInteraction({
          interactionId: it.id,
          prompt: data.prompt,
          explanation: data.explanation,
          startSeconds: data.startSeconds,
          config: buildProtoConfig(data),
        });
        if (res.interaction) { onUpdate(res.interaction); setEditing(false); }
      } catch (err) {
        setSaveError(err instanceof ConnectError ? err.message : "Không thể lưu câu hỏi");
      }
    });
  }

  function handleDelete() {
    setDeleteError(null);
    startDelete(async () => {
      try {
        await interactionClient.deleteInteraction({ interactionId: it.id });
        onDelete(it.id);
      } catch (err) {
        setDeleteError(err instanceof ConnectError ? err.message : "Không thể xoá câu hỏi");
      }
    });
  }

  const busy = disabled || saving || deleting;

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <InteractionForm
          initial={formFromInteraction(it)}
          onSave={handleSave}
          onCancel={() => { setEditing(false); setSaveError(null); }}
          saving={saving}
          error={saveError}
          lessonId={lessonId}
          token={token}
        />
      </div>
    );
  }

  const regenerateModal = (
    <RegenerateModal
      open={regenerateOpen}
      onClose={() => setRegenerateOpen(false)}
      interaction={it}
      token={token}
      onRegenerated={(updated) => { onUpdate(updated); setRegenerateOpen(false); }}
    />
  );

  const mcq = it.config.case === "mcq" ? it.config.value : null;
  const fb = it.config.case === "fillBlank" ? it.config.value : null;

  return (
    <div className={[
      "flex flex-col gap-1.5 px-3 py-2 rounded-md border border-border border-l-2",
      KIND_BORDER_L_CLS[it.kind] ?? "border-l-border",
    ].join(" ")}>
      <div className="flex items-start gap-2">
        <span className="text-xs text-muted-foreground font-medium shrink-0 pt-0.5">{index + 1}.</span>
        <div className="flex-1 flex flex-col gap-0.5 min-w-0">
          <span className={[
            "inline-flex items-center self-start text-[10px] font-medium px-1.5 py-0.5 rounded",
            KIND_BADGE_CLS[it.kind] ?? "bg-muted text-muted-foreground",
          ].join(" ")}>
            {renderer?.label ?? "Bài tập"}
          </span>
          <p className="text-sm leading-snug">{it.prompt || (fb ? fb.template : "")}</p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{formatTime(it.startSeconds)}</span>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost" size="sm" className="size-6 p-0" title="Chỉnh sửa"
            disabled={busy} onClick={() => setEditing(true)}
            data-testid="edit-interaction-btn"
          >
            <PencilIcon className="size-3" />
          </Button>
          <Button
            variant="ghost" size="sm" className="size-6 p-0" title="Tạo lại"
            disabled={busy} onClick={() => setRegenerateOpen(true)}
            data-testid="regenerate-interaction-btn"
          >
            <RefreshCwIcon className="size-3" />
          </Button>
          <Button
            variant="ghost" size="sm"
            className="size-6 p-0 text-destructive hover:text-destructive"
            title="Xóa" disabled={busy} onClick={handleDelete}
            data-testid="delete-interaction-btn"
          >
            {deleting ? <Loader2Icon className="size-3 animate-spin" /> : <Trash2Icon className="size-3" />}
          </Button>
        </div>
      </div>

      {mcq && (
        <div className="grid grid-cols-1 gap-0.5 ml-4">
          {mcq.options.map((opt, oi) => (
            <div
              key={oi}
              className={`text-xs px-2 py-0.5 rounded border ${
                oi === mcq.correctAnswer
                  ? "border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                  : "border-transparent text-muted-foreground"
              }`}
            >
              {String.fromCharCode(65 + oi)}. {opt.text}
            </div>
          ))}
        </div>
      )}
      {fb && <p className="text-xs text-muted-foreground ml-4 font-mono">{fb.template}</p>}
      {it.explanation && <p className="text-xs text-muted-foreground ml-4 italic">{it.explanation}</p>}
      {deleteError && <p className="text-xs text-destructive ml-4">{deleteError}</p>}
      {regenerateModal}
    </div>
  );
}
