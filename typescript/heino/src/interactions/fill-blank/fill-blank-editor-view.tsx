"use client";

import type { EditorViewProps, FillBlankConfig } from "../types";
import { AutoTextarea } from "../_shared/auto-textarea";

const PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

function countPlaceholders(template: string): number {
  return [...template.matchAll(PLACEHOLDER_RE)].length;
}

export function FillBlankEditorView({ config, onChange }: EditorViewProps<FillBlankConfig>) {
  function handleTemplateChange(template: string) {
    const count = countPlaceholders(template);
    const blanks = Array.from({ length: count }, (_, i) =>
      config.blanks[i] ?? { accepted: [], caseSensitive: false, hint: "" }
    );
    onChange({ ...config, template, blanks });
  }

  function setAccepted(i: number, raw: string) {
    const accepted = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({
      ...config,
      blanks: config.blanks.map((b, idx) => (idx === i ? { ...b, accepted } : b)),
    });
  }

  function setCaseSensitive(i: number, val: boolean) {
    onChange({
      ...config,
      blanks: config.blanks.map((b, idx) => (idx === i ? { ...b, caseSensitive: val } : b)),
    });
  }

  function setHint(i: number, hint: string) {
    onChange({
      ...config,
      blanks: config.blanks.map((b, idx) => (idx === i ? { ...b, hint } : b)),
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          Template <span className="font-mono">{"{{0}}"}</span>, <span className="font-mono">{"{{1}}"}</span>, … cho chỗ trống
        </label>
        <textarea
          value={config.template}
          onChange={(e) => handleTemplateChange(e.target.value)}
          rows={3}
          placeholder='Ví dụ: "Năng lượng không thể {{0}}, mà chỉ {{1}} từ dạng này sang dạng khác."'
          className="rounded border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
        />
      </div>

      {config.blanks.map((blank, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded border border-border p-2">
          <p className="text-xs font-medium text-muted-foreground">Chỗ trống {"{{"}{i}{"}}"}</p>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Đáp án chấp nhận (phân cách bằng dấu phẩy)</label>
            <AutoTextarea
              value={blank.accepted.join(", ")}
              onChange={(text) => setAccepted(i, text)}
              placeholder="ví dụ: tự sinh ra, được tạo ra"
              className="rounded border border-input bg-background px-2 py-1 text-sm text-foreground"
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={blank.caseSensitive}
                onChange={(e) => setCaseSensitive(i, e.target.checked)}
                className="size-3.5 rounded border-border"
              />
              Phân biệt hoa/thường
            </label>
            <div className="flex items-center gap-1.5 flex-1">
              <label className="text-xs text-muted-foreground shrink-0">Gợi ý:</label>
              <input
                type="text"
                value={blank.hint}
                onChange={(e) => setHint(i, e.target.value)}
                placeholder="tuỳ chọn"
                className="flex-1 rounded border border-input bg-background px-2 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
        </div>
      ))}

      {config.blanks.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          Thêm <span className="font-mono">{"{{0}}"}</span> vào template để tạo chỗ trống.
        </p>
      )}
    </div>
  );
}
