"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { EditorViewProps, ReadingConfig } from "../types";

export function ReadingEditorView({ config, onChange }: EditorViewProps<ReadingConfig>) {
  const [previewPassage, setPreviewPassage] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      {/* Mode */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Chế độ</label>
        <select
          value={config.mode}
          onChange={(e) => onChange({ ...config, mode: e.target.value as "pronunciation" | "open_answer" })}
          className="text-sm rounded border border-input bg-background px-2 py-1.5"
        >
          <option value="pronunciation">🗣 Đọc to (Pronunciation)</option>
          <option value="open_answer">💬 Trả lời câu hỏi (Open Answer)</option>
        </select>
      </div>

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

      {/* Question + expected answer (open_answer only) */}
      {config.mode === "open_answer" && (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Câu hỏi</label>
            <input
              type="text"
              value={config.question ?? ""}
              onChange={(e) => onChange({ ...config, question: e.target.value })}
              placeholder="Câu hỏi học sinh phải trả lời bằng lời nói…"
              className="text-sm rounded border border-input bg-background px-2 py-1.5"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">
              Đáp án mẫu <span className="text-muted-foreground/70">(tham chiếu để AI chấm, hiện cho học sinh sau khi nộp)</span>
            </label>
            <textarea
              rows={2}
              value={config.expectedAnswer ?? ""}
              onChange={(e) => onChange({ ...config, expectedAnswer: e.target.value })}
              placeholder="Đáp án mẫu ngắn gọn…"
              className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none"
            />
          </div>
        </>
      )}
    </div>
  );
}
