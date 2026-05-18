"use client";

import { CheckIcon } from "lucide-react";
import type { EditorViewProps, McqConfig } from "../types";

export function McqEditorView({ config, onChange }: EditorViewProps<McqConfig>) {
  function setOptionText(idx: number, text: string) {
    onChange({
      ...config,
      options: config.options.map((o, i) => (i === idx ? { text } : o)),
    });
  }

  function setCorrect(idx: number) {
    onChange({ ...config, correctAnswer: idx });
  }

  return (
    <div className="flex flex-col gap-2">
      {config.options.map((opt, oi) => {
        const isCorrect = config.correctAnswer === oi;
        return (
          <div key={oi} className="flex items-center gap-2">
            <button
              type="button"
              title={isCorrect ? "Đang là đáp án đúng" : "Chọn làm đáp án đúng"}
              onClick={() => setCorrect(oi)}
              className={`shrink-0 size-5 rounded-full border-2 flex items-center justify-center transition-colors
                ${isCorrect
                  ? "border-green-500 bg-green-500 text-white"
                  : "border-border hover:border-green-400"}`}
            >
              {isCorrect && <CheckIcon className="size-3" />}
            </button>
            <span className="text-xs text-muted-foreground w-4 shrink-0 text-center">
              {String.fromCharCode(65 + oi)}.
            </span>
            <input
              type="text"
              value={opt.text}
              onChange={(e) => setOptionText(oi, e.target.value)}
              placeholder={`Lựa chọn ${String.fromCharCode(65 + oi)}`}
              className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        );
      })}
    </div>
  );
}
