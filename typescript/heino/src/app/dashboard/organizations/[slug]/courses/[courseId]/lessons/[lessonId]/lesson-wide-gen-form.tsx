"use client";

import { Button } from "@/components/ui/button";
import { SparklesIcon } from "lucide-react";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
] as const;

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

interface LessonWideGenFormProps {
  chunks: TranscriptChunk[];
  interactionsCount: number;
  defaultCount: number;
  defaultKinds: InteractionKind[];
  disabled: boolean;
  force: boolean;
  onForceChange: (v: boolean) => void;
  onGenerate: () => void;
  onCancel: () => void;
  hasDefaultConfig: boolean;
  onOpenDefaultConfig: () => void;
}

export function LessonWideGenForm({
  chunks, interactionsCount, defaultCount, defaultKinds, disabled,
  force, onForceChange, onGenerate, onCancel,
  hasDefaultConfig, onOpenDefaultConfig,
}: LessonWideGenFormProps) {
  const chunksWithoutConfig = chunks.filter(c => !c.interactionConfig);
  const showConfigWarning = !hasDefaultConfig && chunksWithoutConfig.length > 0;

  return (
    <div className="rounded-md border border-border p-3 bg-background flex flex-col gap-2">
      <p className="text-xs font-medium">🤖 Tạo bài tập AI — Toàn lesson</p>

      {showConfigWarning && (
        <div className="rounded border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-2.5 py-2 flex flex-col gap-1">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            ⚠ {chunksWithoutConfig.length} phân đoạn chưa có cấu hình riêng. Sẽ dùng mặc định (2 MCQ).
          </p>
          <button
            type="button"
            className="text-xs text-amber-700 dark:text-amber-400 underline underline-offset-2 text-left hover:opacity-80"
            onClick={onOpenDefaultConfig}
          >
            Lưu cấu hình mặc định trước
          </button>
        </div>
      )}

      {chunks.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">Sẽ áp dụng cấu hình của từng phân đoạn:</p>
          <div className="max-h-40 overflow-y-auto flex flex-col gap-0.5">
            {chunks.map((chunk, i) => {
              const cfg = chunk.interactionConfig;
              const count = cfg ? cfg.count : defaultCount;
              const kindLabels = (cfg?.kinds?.length ? cfg.kinds : defaultKinds)
                .map(k => KIND_OPTIONS.find(o => o.kind === k)?.label ?? "")
                .filter(Boolean)
                .join(", ");
              return (
                <p key={chunk.id} className="text-xs">
                  <span className="text-muted-foreground">
                    Đoạn {i + 1} ({formatTime(chunk.startSeconds)}–{formatTime(chunk.endSeconds)}):
                  </span>
                  {" "}{count} bài · {kindLabels}
                  {!cfg && <span className="text-muted-foreground"> ← mặc định</span>}
                </p>
              );
            })}
          </div>
          <p className="text-xs font-medium">
            Tổng:{" "}
            {chunks.reduce((s, c) => s + (c.interactionConfig ? c.interactionConfig.count : defaultCount), 0)}{" "}
            bài tập sẽ được tạo
          </p>
        </>
      )}

      {interactionsCount > 0 && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => onForceChange(e.target.checked)}
          />
          <span className="text-xs">Thay thế bài tập hiện có ({interactionsCount} bài)</span>
        </label>
      )}

      <div className="flex gap-2">
        <Button size="sm" className="gap-1" disabled={disabled} onClick={onGenerate}>
          <SparklesIcon className="size-3" />
          Tạo tất cả
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Hủy</Button>
      </div>
    </div>
  );
}
