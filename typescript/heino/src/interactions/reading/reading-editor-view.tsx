"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EditorViewProps, ReadingConfig, McqConfig } from "../types";
import { NestedMcqEditor } from "../_shared/nested-mcq";

const EMPTY_MCQ: McqConfig = {
  options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
  correctAnswer: 0,
};

export function ReadingEditorView({ config, onChange }: EditorViewProps<ReadingConfig>) {
  const [previewPassage, setPreviewPassage] = useState(false);

  function addQuestion() {
    onChange({ ...config, questions: [...config.questions, { ...EMPTY_MCQ, options: EMPTY_MCQ.options.map((o) => ({ ...o })) }] });
  }

  function updateQuestion(qi: number, q: McqConfig) {
    onChange({ ...config, questions: config.questions.map((c, i) => (i === qi ? q : c)) });
  }

  function removeQuestion(qi: number) {
    onChange({ ...config, questions: config.questions.filter((_, i) => i !== qi) });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Passage */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Đoạn văn (Markdown)</label>
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setPreviewPassage((p) => !p)}
          >
            {previewPassage ? "Chỉnh sửa" : "Xem trước"}
          </button>
        </div>
        {previewPassage ? (
          <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/20 px-3 py-2 text-sm min-h-[80px]">
            <ReactMarkdown>{config.passageMarkdown || "_Chưa có nội dung_"}</ReactMarkdown>
          </div>
        ) : (
          <textarea
            rows={5}
            value={config.passageMarkdown}
            onChange={(e) => onChange({ ...config, passageMarkdown: e.target.value })}
            placeholder="Nhập đoạn văn bản học sinh cần đọc…"
            className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none font-mono"
          />
        )}
      </div>

      {/* Questions */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted-foreground">Câu hỏi ({config.questions.length})</label>
        {config.questions.map((q, qi) => (
          <NestedMcqEditor
            key={qi}
            questionIndex={qi}
            config={q}
            onChange={(updated) => updateQuestion(qi, updated)}
            onRemove={() => removeQuestion(qi)}
          />
        ))}
        <Button type="button" variant="outline" size="sm" className="gap-1.5 self-start" onClick={addQuestion}>
          <PlusIcon className="size-3.5" /> Thêm câu hỏi
        </Button>
      </div>
    </div>
  );
}
