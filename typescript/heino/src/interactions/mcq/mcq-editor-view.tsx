"use client";

import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { EditorViewProps, McqConfig } from "../types";
import { AutoTextarea } from "../_shared/auto-textarea";

export function McqEditorView({ config, onChange }: EditorViewProps<McqConfig>) {
  const isMultiple = Array.isArray(config.correctAnswers);
  const options = config.options || [];

  function setOptionText(idx: number, text: string) {
    onChange({
      ...config,
      options: options.map((o, i) => (i === idx ? { text } : o)),
    });
  }

  function toggleCorrect(idx: number) {
    if (isMultiple) {
      const current = config.correctAnswers || [];
      const next = current.includes(idx)
        ? current.filter((i) => i !== idx)
        : [...current, idx];
      onChange({
        ...config,
        correctAnswers: next,
      });
    } else {
      onChange({
        ...config,
        correctAnswer: idx,
      });
    }
  }

  function addOption() {
    onChange({
      ...config,
      options: [...options, { text: "" }],
    });
  }

  function removeOption(idx: number) {
    if (options.length <= 2) return; // Bảo vệ tối thiểu 2 đáp án
    const nextOptions = options.filter((_, i) => i !== idx);

    if (isMultiple) {
      const current = config.correctAnswers || [];
      // Lọc bỏ và cập nhật lại chỉ mục
      const nextAnswers = current
        .filter((i) => i !== idx)
        .map((i) => (i > idx ? i - 1 : i));
      onChange({
        ...config,
        options: nextOptions,
        correctAnswers: nextAnswers,
      });
    } else {
      let nextCorrect = config.correctAnswer;
      if (nextCorrect === idx) {
        nextCorrect = 0; // fallback về lựa chọn đầu tiên
      } else if (nextCorrect > idx) {
        nextCorrect = nextCorrect - 1; // dịch chuyển chỉ mục
      }
      onChange({
        ...config,
        options: nextOptions,
        correctAnswer: nextCorrect,
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground font-medium">
        {isMultiple
          ? "Trắc nghiệm nhiều đáp án (Click nút tròn để đánh dấu tất cả các đáp án đúng)"
          : "Trắc nghiệm một đáp án (Click nút tròn để chọn đáp án đúng duy nhất)"}
      </div>

      <div className="flex flex-col gap-2">
        {options.map((opt, oi) => {
          const isCorrect = isMultiple
            ? (config.correctAnswers || []).includes(oi)
            : config.correctAnswer === oi;

          return (
            <div key={oi} className="flex items-start gap-2 group">
              <button
                type="button"
                title={isCorrect ? "Đang là đáp án đúng" : "Chọn làm đáp án đúng"}
                onClick={() => toggleCorrect(oi)}
                className={`mt-1 shrink-0 size-5 rounded border-2 flex items-center justify-center transition-colors
                  ${isCorrect
                    ? "border-green-500 bg-green-500 text-white"
                    : "border-border hover:border-green-400"}
                  ${!isMultiple ? "rounded-full" : "rounded-sm"}`}
              >
                {isCorrect && <CheckIcon className="size-3" />}
              </button>
              <span className="mt-1.5 text-xs font-semibold text-muted-foreground w-4 shrink-0 text-center">
                {String.fromCharCode(65 + oi)}.
              </span>
              <AutoTextarea
                value={opt.text}
                onChange={(text) => setOptionText(oi, text)}
                placeholder={`Lựa chọn ${String.fromCharCode(65 + oi)}`}
                className="flex-1 rounded border border-input bg-background px-3 py-1.5 text-sm text-foreground"
              />
              {options.length > 2 && (
                <button
                  type="button"
                  title="Xóa lựa chọn này"
                  onClick={() => removeOption(oi)}
                  className="mt-0.5 shrink-0 p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  <Trash2Icon className="size-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addOption}
        className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-input text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all"
      >
        <PlusIcon className="size-3.5" />
        Thêm lựa chọn
      </button>
    </div>
  );
}
