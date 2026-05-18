"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  PencilIcon, Trash2Icon, PlusIcon,
  CheckIcon, Loader2Icon, ChevronDownIcon,
} from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";
import { getRenderer, extractConfig } from "@/interactions/registry";
import type { McqConfig, FillBlankConfig, ListeningConfig, ReadingConfig } from "@/interactions/types";

// ── Interaction form (shared by edit & add) ───────────────────────────────────

interface InteractionFormData {
  kind: InteractionKind;
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any; // McqConfig | FillBlankConfig
  explanation: string;
  startSeconds: number;
}

function emptyMcqForm(): InteractionFormData {
  return {
    kind: InteractionKind.MCQ,
    prompt: "",
    config: {
      options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
      correctAnswer: 0,
    } satisfies McqConfig,
    explanation: "",
    startSeconds: 0,
  };
}

function emptyFillBlankForm(): InteractionFormData {
  return {
    kind: InteractionKind.FILL_BLANK,
    prompt: "",
    config: { template: "", blanks: [] } satisfies FillBlankConfig,
    explanation: "",
    startSeconds: 0,
  };
}

function emptyListeningForm(): InteractionFormData {
  return {
    kind: InteractionKind.LISTENING,
    prompt: "",
    config: {
      audioObjectKey: "",
      durationSeconds: 0,
      mode: "comprehension",
      expectedText: "",
      comprehensionQuestions: [],
    } satisfies ListeningConfig,
    explanation: "",
    startSeconds: 0,
  };
}

function emptyReadingForm(): InteractionFormData {
  return {
    kind: InteractionKind.READING,
    prompt: "",
    config: { passageMarkdown: "", questions: [] } satisfies ReadingConfig,
    explanation: "",
    startSeconds: 0,
  };
}

function emptyFormForKind(kind: InteractionKind): InteractionFormData {
  if (kind === InteractionKind.FILL_BLANK) return emptyFillBlankForm();
  if (kind === InteractionKind.LISTENING) return emptyListeningForm();
  if (kind === InteractionKind.READING) return emptyReadingForm();
  return emptyMcqForm();
}

function formFromInteraction(it: LessonInteraction): InteractionFormData {
  return {
    kind: it.kind,
    prompt: it.prompt,
    config: extractConfig(it) ?? emptyMcqForm().config,
    explanation: it.explanation,
    startSeconds: it.startSeconds,
  };
}

function isSaveable(form: InteractionFormData): boolean {
  if (!form.prompt.trim()) return false;
  if (form.kind === InteractionKind.MCQ) {
    const c = form.config as McqConfig;
    return c.options?.every((o: { text: string }) => o.text.trim() !== "") ?? false;
  }
  if (form.kind === InteractionKind.FILL_BLANK) {
    const c = form.config as FillBlankConfig;
    return (
      c.template?.trim() !== "" &&
      c.blanks?.length > 0 &&
      c.blanks.every((b) => b.accepted.length > 0)
    );
  }
  if (form.kind === InteractionKind.LISTENING) {
    const c = form.config as ListeningConfig;
    if (!c.audioObjectKey) return false;
    if (c.mode === "dictation") return c.expectedText.trim() !== "";
    if (c.mode === "comprehension") return c.comprehensionQuestions.length > 0;
    return false;
  }
  if (form.kind === InteractionKind.READING) {
    const c = form.config as ReadingConfig;
    return c.passageMarkdown.trim() !== "" && c.questions.length > 0;
  }
  return false;
}

function buildProtoConfig(form: InteractionFormData) {
  if (form.kind === InteractionKind.FILL_BLANK) {
    const c = form.config as FillBlankConfig;
    return {
      case: "fillBlank" as const,
      value: {
        template: c.template,
        blanks: c.blanks.map((b) => ({
          accepted: b.accepted,
          caseSensitive: b.caseSensitive,
          hint: b.hint,
        })),
      },
    };
  }
  if (form.kind === InteractionKind.LISTENING) {
    const c = form.config as ListeningConfig;
    return {
      case: "listening" as const,
      value: {
        audioObjectKey: c.audioObjectKey,
        durationSeconds: c.durationSeconds,
        mode: c.mode === "dictation" ? 1 : 2,
        expectedText: c.expectedText,
        comprehensionQuestions: c.comprehensionQuestions.map((q) => ({
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
        passageMarkdown: c.passageMarkdown,
        questions: c.questions.map((q) => ({
          options: q.options.map((o) => ({ text: o.text })),
          correctAnswer: q.correctAnswer,
        })),
      },
    };
  }
  // default: MCQ
  const c = form.config as McqConfig;
  return {
    case: "mcq" as const,
    value: {
      options: c.options.map((o) => ({ text: o.text })),
      correctAnswer: c.correctAnswer,
    },
  };
}

interface InteractionFormProps {
  initial: InteractionFormData;
  onSave: (data: InteractionFormData) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  lessonId: string;
  token: string;
}

function InteractionForm({ initial, onSave, onCancel, saving, error, lessonId, token }: InteractionFormProps) {
  const [form, setForm] = useState<InteractionFormData>(initial);

  let renderer;
  try {
    renderer = getRenderer(form.kind);
  } catch {
    return <p className="text-xs text-destructive">Loại câu hỏi không được hỗ trợ.</p>;
  }

  const canSave = isSaveable(form);

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
            type="number"
            min={0}
            step={1}
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
        <Button size="sm" onClick={() => onSave(form)} disabled={saving || !canSave} className="gap-1">
          {saving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
          Lưu
        </Button>
      </div>
    </div>
  );
}

// ── Single interaction row ─────────────────────────────────────────────────────

interface InteractionRowProps {
  interaction: LessonInteraction;
  index: number;
  onUpdate: (it: LessonInteraction) => void;
  onDelete: (id: string) => void;
  interactionClient: ReturnType<typeof useRichterWebClient<typeof InteractionService>>;
  lessonId: string;
  token: string;
}

function InteractionRow({ interaction: it, index, onUpdate, onDelete, interactionClient, lessonId, token }: InteractionRowProps) {
  const [editing, setEditing] = useState(false);
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

  const busy = saving || deleting;

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground ml-1">Câu {index + 1}</p>
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

  const mcq = it.config.case === "mcq" ? it.config.value : null;
  const fb = it.config.case === "fillBlank" ? it.config.value : null;

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border border-border">
      <div className="flex items-start gap-2">
        <span className="text-sm font-medium shrink-0">{index + 1}.</span>
        <div className="flex-1 flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">{renderer?.label ?? "Bài tập"}</p>
          <p className="text-sm">{it.prompt || (fb ? fb.template : "")}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost" size="sm" className="size-7 p-0" title="Chỉnh sửa"
            disabled={busy} onClick={() => setEditing(true)}
            data-testid="edit-question-btn"
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost" size="sm"
            className="size-7 p-0 text-destructive hover:text-destructive"
            title="Xóa" disabled={busy} onClick={handleDelete}
            data-testid="delete-question-btn"
          >
            {deleting ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
          </Button>
        </div>
      </div>

      {mcq && (
        <div className="grid grid-cols-1 gap-1 ml-4">
          {mcq.options.map((opt, oi) => (
            <div
              key={oi}
              className={`text-sm px-3 py-1 rounded-md border ${
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

      {fb && (
        <p className="text-xs text-muted-foreground ml-4 font-mono">{fb.template}</p>
      )}

      {it.explanation && (
        <p className="text-xs text-muted-foreground ml-4 italic">{it.explanation}</p>
      )}
      <p className="text-xs text-muted-foreground ml-4">
        ⏱ {it.startSeconds > 0
          ? `${Math.floor(it.startSeconds / 60)}:${String(Math.floor(it.startSeconds % 60)).padStart(2, "0")}`
          : "—"}
      </p>

      {deleteError && <p data-testid="delete-error" className="text-xs text-destructive ml-4">{deleteError}</p>}
    </div>
  );
}

// ── Main editor ───────────────────────────────────────────────────────────────

interface Props {
  lessonId: string;
  initialInteractions: LessonInteraction[];
  token: string;
}

export function InteractionEditorList({ lessonId, initialInteractions, token }: Props) {
  const interactionClient = useRichterWebClient(InteractionService, token);
  const [interactions, setInteractions] = useState<LessonInteraction[]>(initialInteractions);
  const [addingKind, setAddingKind] = useState<InteractionKind | null>(null);
  const [showKindPicker, setShowKindPicker] = useState(false);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  function handleUpdate(updated: LessonInteraction) {
    setInteractions((its) => its.map((it) => (it.id === updated.id ? updated : it)));
  }

  function handleDelete(id: string) {
    setInteractions((its) => its.filter((it) => it.id !== id));
  }

  function handleAdd(data: InteractionFormData) {
    setAddError(null);
    startAddSave(async () => {
      try {
        const res = await interactionClient.createManualInteraction({
          lessonId,
          prompt: data.prompt,
          explanation: data.explanation,
          startSeconds: data.startSeconds,
          config: buildProtoConfig(data),
        });
        if (res.interaction) {
          setInteractions((its) => [...its, res.interaction!]);
          setAddingKind(null);
        }
      } catch (err) {
        setAddError(err instanceof ConnectError ? err.message : "Không thể thêm câu hỏi");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {interactions.map((it, i) => (
        <InteractionRow
          key={it.id}
          interaction={it}
          index={i}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          interactionClient={interactionClient}
          lessonId={lessonId}
          token={token}
        />
      ))}

      {addingKind !== null ? (
        <InteractionForm
          initial={emptyFormForKind(addingKind)}
          onSave={handleAdd}
          onCancel={() => { setAddingKind(null); setAddError(null); setShowKindPicker(false); }}
          saving={addSaving}
          error={addError}
          lessonId={lessonId}
          token={token}
        />
      ) : showKindPicker ? (
        <div className="flex flex-col gap-1 p-2 rounded-md border border-border bg-muted/30">
          <p className="text-xs text-muted-foreground px-1">Chọn loại bài tập:</p>
          <button
            type="button"
            className="text-left text-sm px-3 py-2 rounded hover:bg-muted transition-colors"
            onClick={() => { setShowKindPicker(false); setAddingKind(InteractionKind.MCQ); }}
          >
            Trắc nghiệm
          </button>
          <button
            type="button"
            className="text-left text-sm px-3 py-2 rounded hover:bg-muted transition-colors"
            onClick={() => { setShowKindPicker(false); setAddingKind(InteractionKind.FILL_BLANK); }}
          >
            Điền đáp án
          </button>
          <button
            type="button"
            className="text-left text-sm px-3 py-2 rounded hover:bg-muted transition-colors"
            onClick={() => { setShowKindPicker(false); setAddingKind(InteractionKind.LISTENING); }}
          >
            Bài nghe
          </button>
          <button
            type="button"
            className="text-left text-sm px-3 py-2 rounded hover:bg-muted transition-colors"
            onClick={() => { setShowKindPicker(false); setAddingKind(InteractionKind.READING); }}
          >
            Bài đọc
          </button>
          <Button variant="ghost" size="sm" className="self-start mt-1" onClick={() => setShowKindPicker(false)}>
            Hủy
          </Button>
        </div>
      ) : (
        <Button
          variant="outline" size="sm" className="gap-2 self-start"
          onClick={() => setShowKindPicker(true)}
          data-testid="add-question-btn"
        >
          <PlusIcon className="size-3.5" />
          Thêm bài tập
          <ChevronDownIcon className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
