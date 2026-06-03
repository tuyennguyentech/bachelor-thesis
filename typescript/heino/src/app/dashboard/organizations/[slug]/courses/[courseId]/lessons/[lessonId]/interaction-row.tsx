"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  PencilIcon, Trash2Icon, CheckIcon, Loader2Icon, RefreshCwIcon, MoreHorizontalIcon,
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
  [InteractionKind.SINGLE_CHOICE]: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400",
  [InteractionKind.MULTIPLE_CHOICE]: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
  [InteractionKind.FILL_BLANK]: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  [InteractionKind.LISTENING]: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  [InteractionKind.READING]: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400",
};

export const KIND_BORDER_L_CLS: Partial<Record<InteractionKind, string>> = {
  [InteractionKind.SINGLE_CHOICE]: "border-l-rose-400",
  [InteractionKind.MULTIPLE_CHOICE]: "border-l-purple-400",
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
      config: { mode: "pronunciation", passageMarkdown: "", question: "" } satisfies ReadingConfig,
      explanation: "", startSeconds: 0,
    };
  }
  if (kind === InteractionKind.MULTIPLE_CHOICE) {
    return {
      kind, prompt: "",
      config: { options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }], correctAnswer: -1, correctAnswers: [0] } satisfies McqConfig,
      explanation: "", startSeconds: 0,
    };
  }
  return {
    kind: InteractionKind.SINGLE_CHOICE, prompt: "",
    config: { options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }], correctAnswer: 0, correctAnswers: [] } satisfies McqConfig,
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
  if (form.kind === InteractionKind.SINGLE_CHOICE || form.kind === InteractionKind.MULTIPLE_CHOICE) {
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
    return c.comprehensionQuestions.length > 0 && c.comprehensionQuestions.every((q) =>
      (q.question?.trim() ?? "") !== "" && q.options.every((o) => o.text.trim() !== ""),
    );
  }
  if (form.kind === InteractionKind.READING) {
    const c = form.config as ReadingConfig;
    return c.passageMarkdown.trim() !== "";
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
        expectedText: c.expectedText,
        comprehensionQuestions: c.comprehensionQuestions.map((q) => ({
          question: q.question ?? "",
          options: q.options.map((o) => ({ text: o.text })),
          correctAnswer: q.correctAnswer,
        })),
      },
    };
  }
  if (form.kind === InteractionKind.READING) {
    const c = form.config as ReadingConfig;
    return {
      case: "reading" as const,
      value: {
        mode: c.mode === "open_answer" ? 2 : 1,
        passageMarkdown: c.passageMarkdown,
        question: c.question ?? "",
        expectedAnswer: c.expectedAnswer ?? "",
      },
    };
  }
  const c = form.config as McqConfig;
  return {
    case: "mcq" as const,
    value: {
      options: c.options.map((o) => ({ text: o.text })),
      question: c.question ?? "",
      correctAnswer: c.correctAnswer,
      correctAnswers: c.correctAnswers ? [...c.correctAnswers] : [],
    },
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
    <div className="flex flex-col gap-4 p-4 bg-muted/20 rounded-lg border border-border">
      <p className="text-sm font-medium text-muted-foreground">{renderer.label}</p>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-muted-foreground">
          {form.kind === InteractionKind.FILL_BLANK ? "Câu dẫn (tuỳ chọn)" :
           form.kind === InteractionKind.LISTENING ? "Tiêu đề bài nghe" :
           form.kind === InteractionKind.READING ? "Tiêu đề bài đọc" : "Câu hỏi"}
        </label>
        <textarea
          rows={2}
          value={form.prompt}
          onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
          className="text-sm rounded-lg border border-input bg-background px-3 py-2 resize-none"
          placeholder="Nhập câu hỏi..."
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        {form.kind !== InteractionKind.LISTENING && form.kind !== InteractionKind.READING && (
          <label className="text-sm text-muted-foreground">
            {form.kind === InteractionKind.SINGLE_CHOICE || form.kind === InteractionKind.MULTIPLE_CHOICE
              ? "Cấu hình các lựa chọn đáp án"
              : "Template & chỗ trống"}
          </label>
        )}
        <renderer.EditorView
          config={form.config}
          onChange={(c) => setForm((f) => ({ ...f, config: c }))}
          lessonId={lessonId}
          token={token}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Giải thích đáp án</label>
          <input
            type="text"
            value={form.explanation}
            onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))}
            disabled={saving}
            placeholder="Không bắt buộc"
            className="text-sm rounded-lg border border-input bg-background px-3 py-2"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-muted-foreground">Thời điểm (giây)</label>
          <input
            type="number" min={0} step={1}
            value={form.startSeconds}
            onChange={(e) => setForm((f) => ({ ...f, startSeconds: parseFloat(e.target.value) || 0 }))}
            disabled={saving}
            className="text-sm rounded-lg border border-input bg-background px-3 py-2"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Hủy</Button>
        <Button onClick={() => onSave(form)} disabled={saving || !isSaveable(form)} className="gap-1.5">
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
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

  const editDialog = (
    <Dialog open={editing} onOpenChange={(o) => !o && !saving && setEditing(false)}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa bài tập</DialogTitle>
        </DialogHeader>
        <InteractionForm
          initial={formFromInteraction(it)}
          onSave={handleSave}
          onCancel={() => { setEditing(false); setSaveError(null); }}
          saving={saving}
          error={saveError}
          lessonId={lessonId}
          token={token}
        />
      </DialogContent>
    </Dialog>
  );

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
    <div data-testid="interaction-row" className={[
      "flex flex-col gap-2.5 px-4 py-3.5 rounded-xl border border-border border-l-3 bg-background hover:bg-muted/10 transition-colors",
      KIND_BORDER_L_CLS[it.kind] ?? "border-l-border",
    ].join(" ")}>
      <div className="flex items-start gap-3">
        <span className="text-sm text-muted-foreground font-bold shrink-0 pt-0.5">{index + 1}</span>
        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className={[
              "inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-lg",
              KIND_BADGE_CLS[it.kind] ?? "bg-muted text-muted-foreground",
            ].join(" ")}>
              {renderer?.label ?? "Bài tập"}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums font-mono bg-muted rounded-md px-1.5 py-0.5">
              {formatTime(it.startSeconds)}
            </span>
          </div>
          <p className="text-sm leading-relaxed">{it.prompt || (fb ? fb.template : "")}</p>
        </div>
        <div className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-8 p-0 rounded-lg"
            disabled={busy}
            onClick={() => setEditing(true)}
            title="Chỉnh sửa"
            data-testid="edit-interaction-btn"
          >
            <PencilIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-8 p-0 rounded-lg text-destructive hover:text-destructive"
            disabled={busy}
            onClick={handleDelete}
            title="Xóa"
            data-testid="delete-interaction-btn"
          >
            <Trash2Icon className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0 rounded-lg"
                disabled={busy}
                data-testid="interaction-actions-btn"
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl">
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => setEditing(true)}
                className="rounded-lg"
              >
                <PencilIcon className="size-4 mr-2" />
                Chỉnh sửa
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => setRegenerateOpen(true)}
                data-testid="regenerate-interaction-btn"
                className="rounded-lg"
              >
                <RefreshCwIcon className="size-4 mr-2" />
                Tạo lại bằng AI
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive rounded-lg"
                disabled={busy}
                onSelect={handleDelete}
              >
                <Trash2Icon className="size-4 mr-2" />
                Xóa
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {mcq && (
        <div className="grid grid-cols-1 gap-1 ml-6">
          {mcq.options.map((opt, oi) => (
            <div
              key={oi}
              className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
                oi === mcq.correctAnswer
                  ? "bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400 font-medium border border-green-200 dark:border-green-800"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              <span className="font-mono text-xs mr-2">{String.fromCharCode(65 + oi)}.</span>
              {opt.text}
            </div>
          ))}
        </div>
      )}
      {fb && <p className="text-sm text-muted-foreground ml-6 font-mono bg-muted/30 rounded-lg px-3 py-2">{fb.template}</p>}
      {it.explanation && <p className="text-xs text-muted-foreground ml-6 italic">{it.explanation}</p>}
      {deleteError && <p className="text-xs text-destructive ml-6">{deleteError}</p>}
      {editDialog}
      {regenerateModal}
    </div>
  );
}
