"use client";

import type { EditorViewProps, WritingConfig } from "../types";

export function WritingEditorView({ config, onChange }: EditorViewProps<WritingConfig>) {
  return (
    <div data-testid="writing-editor" className="flex flex-col gap-3">
      {/* Prompt (required) */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Đề bài (bắt buộc)</label>
        <textarea
          data-testid="writing-editor-prompt"
          rows={3}
          value={config.prompt}
          onChange={(e) => onChange({ ...config, prompt: e.target.value })}
          placeholder="Nhập đề bài / chủ đề học sinh cần viết…"
          className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Rubric (optional) */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          Tiêu chí chấm điểm <span className="text-muted-foreground/70">(tuỳ chọn, hiện cho học sinh và dùng để AI chấm)</span>
        </label>
        <textarea
          rows={3}
          value={config.rubric ?? ""}
          onChange={(e) => onChange({ ...config, rubric: e.target.value })}
          placeholder="Ví dụ: bố cục rõ ràng, lập luận thuyết phục, ngữ pháp chính xác…"
          className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Expected / model answer (optional) */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          Bài mẫu <span className="text-muted-foreground/70">(tuỳ chọn, tham chiếu để AI chấm)</span>
        </label>
        <textarea
          rows={3}
          value={config.expectedAnswer ?? ""}
          onChange={(e) => onChange({ ...config, expectedAnswer: e.target.value })}
          placeholder="Bài viết mẫu tham khảo…"
          className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Minimum words */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Số từ tối thiểu (0 = không yêu cầu)</label>
        <input
          type="number"
          min={0}
          step={1}
          value={config.minWords}
          onChange={(e) => onChange({ ...config, minWords: Math.max(0, parseInt(e.target.value, 10) || 0) })}
          className="w-32 text-sm rounded border border-input bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    </div>
  );
}
