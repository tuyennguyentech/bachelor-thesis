"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  PencilIcon, Trash2Icon, RefreshCwIcon, PlusIcon,
  CheckIcon, XIcon, Loader2Icon,
} from "lucide-react";
import type { LessonQuestion } from "buf/gen/richter/v1/ai_pb";
import {
  updateLessonQuestion,
  createManualQuestion,
  deleteLessonQuestion,
  regenerateQuestion,
} from "@/app/actions/ai";

// ── Question form (shared by edit & add) ──────────────────────────────────────

interface QuestionFormData {
  questionText: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  startSeconds: number;
}

function emptyForm(): QuestionFormData {
  return { questionText: "", options: ["", "", "", ""], correctAnswer: 0, explanation: "", startSeconds: 0 };
}

function formFromQuestion(q: LessonQuestion): QuestionFormData {
  return {
    questionText: q.questionText,
    options: q.options.map((o) => o.text),
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    startSeconds: q.startSeconds,
  };
}

interface QuestionFormProps {
  initial: QuestionFormData;
  onSave: (data: QuestionFormData) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}

function QuestionForm({ initial, onSave, onCancel, saving, error }: QuestionFormProps) {
  const [form, setForm] = useState<QuestionFormData>(initial);

  function setOption(i: number, val: string) {
    setForm((f) => { const opts = [...f.options]; opts[i] = val; return { ...f, options: opts }; });
  }

  function addOption() {
    if (form.options.length >= 6) return;
    setForm((f) => ({ ...f, options: [...f.options, ""] }));
  }

  function removeOption(i: number) {
    if (form.options.length <= 2) return;
    setForm((f) => {
      const opts = f.options.filter((_, idx) => idx !== i);
      const ca = f.correctAnswer >= opts.length ? opts.length - 1 : f.correctAnswer;
      return { ...f, options: opts, correctAnswer: ca < 0 ? 0 : ca };
    });
  }

  const canSave = form.questionText.trim() !== "" && form.options.every((o) => o.trim() !== "");

  return (
    <div className="flex flex-col gap-3 p-3 bg-muted/30 rounded-md border border-border">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Câu hỏi</label>
        <textarea
          rows={2}
          value={form.questionText}
          onChange={(e) => setForm((f) => ({ ...f, questionText: e.target.value }))}
          className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none"
          placeholder="Nhập câu hỏi..."
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Các lựa chọn (radio = đáp án đúng)</label>
          {form.options.length < 6 && (
            <button
              type="button"
              onClick={addOption}
              disabled={saving}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              + Thêm lựa chọn
            </button>
          )}
        </div>
        {form.options.map((opt, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="radio"
              name="correctAnswer"
              checked={form.correctAnswer === i}
              onChange={() => setForm((f) => ({ ...f, correctAnswer: i }))}
              disabled={saving}
              className="shrink-0"
            />
            <span className="text-xs text-muted-foreground w-4 shrink-0">{String.fromCharCode(65 + i)}.</span>
            <input
              type="text"
              value={opt}
              onChange={(e) => setOption(i, e.target.value)}
              disabled={saving}
              placeholder={`Lựa chọn ${String.fromCharCode(65 + i)}`}
              className="flex-1 text-sm rounded border border-input bg-background px-2 py-1"
            />
            {form.options.length > 2 && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                disabled={saving}
                className="text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        ))}
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
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Hủy
        </Button>
        <Button
          size="sm"
          onClick={() => onSave(form)}
          disabled={saving || !canSave}
          className="gap-1"
        >
          {saving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
          Lưu
        </Button>
      </div>
    </div>
  );
}

// ── Single question row ────────────────────────────────────────────────────────

interface QuestionRowProps {
  question: LessonQuestion;
  index: number;
  onUpdate: (q: LessonQuestion) => void;
  onDelete: (id: string) => void;
}

function QuestionRow({ question: q, index, onUpdate, onDelete }: QuestionRowProps) {
  const [editing, setEditing] = useState(false);
  const [saving, startSave] = useTransition();
  const [regenerating, startRegen] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);

  function handleSave(data: QuestionFormData) {
    setSaveError(null);
    startSave(async () => {
      const res = await updateLessonQuestion(q.id, data);
      if (res.error) { setSaveError(res.error); return; }
      if (res.question) { onUpdate(res.question); setEditing(false); }
    });
  }

  function handleRegen() {
    setRegenError(null);
    startRegen(async () => {
      const res = await regenerateQuestion(q.id);
      if (res.error) { setRegenError(res.error); return; }
      if (res.question) onUpdate(res.question);
    });
  }

  function handleDelete() {
    startDelete(async () => {
      const res = await deleteLessonQuestion(q.id);
      if (!res.error) onDelete(q.id);
    });
  }

  const busy = saving || regenerating || deleting;

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground ml-1">Câu {index + 1}</p>
        <QuestionForm
          initial={formFromQuestion(q)}
          onSave={handleSave}
          onCancel={() => { setEditing(false); setSaveError(null); }}
          saving={saving}
          error={saveError}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border border-border">
      <div className="flex items-start gap-2">
        <span className="text-sm font-medium shrink-0">{index + 1}.</span>
        <p className="text-sm flex-1">{q.questionText}</p>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost" size="sm"
            className="size-7 p-0"
            title="Chỉnh sửa"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost" size="sm"
            className="size-7 p-0"
            title="Tạo lại bằng AI"
            disabled={busy}
            onClick={handleRegen}
          >
            {regenerating
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <RefreshCwIcon className="size-3.5" />}
          </Button>
          <Button
            variant="ghost" size="sm"
            className="size-7 p-0 text-destructive hover:text-destructive"
            title="Xóa"
            disabled={busy}
            onClick={handleDelete}
          >
            {deleting
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <Trash2Icon className="size-3.5" />}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1 ml-4">
        {q.options.map((opt, oi) => (
          <div
            key={oi}
            className={`text-sm px-3 py-1 rounded-md border ${
              oi === q.correctAnswer
                ? "border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                : "border-transparent text-muted-foreground"
            }`}
          >
            {String.fromCharCode(65 + oi)}. {opt.text}
          </div>
        ))}
      </div>

      {q.explanation && (
        <p className="text-xs text-muted-foreground ml-4 italic">{q.explanation}</p>
      )}
      <p className="text-xs text-muted-foreground ml-4">
        ⏱ {q.startSeconds > 0 ? `${Math.floor(q.startSeconds / 60)}:${String(Math.floor(q.startSeconds % 60)).padStart(2, "0")}` : "—"}
      </p>

      {regenError && <p className="text-xs text-destructive ml-4">{regenError}</p>}
    </div>
  );
}

// ── Main editor ───────────────────────────────────────────────────────────────

interface Props {
  lessonId: string;
  initialQuestions: LessonQuestion[];
}

export function LessonQuestionsEditor({ lessonId, initialQuestions }: Props) {
  const [questions, setQuestions] = useState<LessonQuestion[]>(initialQuestions);
  const [addingNew, setAddingNew] = useState(false);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  function handleUpdate(updated: LessonQuestion) {
    setQuestions((qs) => qs.map((q) => (q.id === updated.id ? updated : q)));
  }

  function handleDelete(id: string) {
    setQuestions((qs) => qs.filter((q) => q.id !== id));
  }

  function handleAdd(data: QuestionFormData) {
    setAddError(null);
    startAddSave(async () => {
      const res = await createManualQuestion(lessonId, data);
      if (res.error) { setAddError(res.error); return; }
      if (res.question) {
        setQuestions((qs) => [...qs, res.question!]);
        setAddingNew(false);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {questions.map((q, i) => (
        <QuestionRow
          key={q.id}
          question={q}
          index={i}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />
      ))}

      {addingNew ? (
        <QuestionForm
          initial={emptyForm()}
          onSave={handleAdd}
          onCancel={() => { setAddingNew(false); setAddError(null); }}
          saving={addSaving}
          error={addError}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="gap-2 self-start"
          onClick={() => setAddingNew(true)}
          data-testid="add-question-btn"
        >
          <PlusIcon className="size-3.5" />
          Thêm câu hỏi
        </Button>
      )}
    </div>
  );
}
