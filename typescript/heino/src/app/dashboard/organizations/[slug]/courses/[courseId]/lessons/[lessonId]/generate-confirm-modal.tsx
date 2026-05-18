"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { SparklesIcon } from "lucide-react";
import type { TranscriptChunk, ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const KIND_LABELS: Partial<Record<InteractionKind, string>> = {
  [InteractionKind.MCQ]: "Trắc nghiệm",
  [InteractionKind.FILL_BLANK]: "Điền đáp án",
  [InteractionKind.READING]: "Bài đọc",
  [InteractionKind.LISTENING]: "Bài nghe",
};

function describeConfig(cfg: ChunkInteractionConfig | undefined, defaultCfg: ChunkInteractionConfig | undefined): string {
  const resolved = cfg ?? defaultCfg;
  if (!resolved) return "2 bài (MCQ — mặc định)";
  const count = resolved.count || 2;
  const kinds = resolved.kinds?.length
    ? resolved.kinds.map((k) => KIND_LABELS[k] ?? "Unknown").join(", ")
    : "Trắc nghiệm";
  return `${count} bài (${kinds})`;
}

// ── Per-chunk mode ────────────────────────────────────────────────────────────

interface ChunkConfirmProps {
  open: boolean;
  onClose: () => void;
  chunk: TranscriptChunk;
  existingCount: number;
  defaultConfig?: ChunkInteractionConfig;
  onConfirm: (force: boolean) => void;
  onOpenConfig: () => void;
}

export function ChunkGenerateConfirmModal({ open, onClose, chunk, existingCount, defaultConfig, onConfirm, onOpenConfig }: ChunkConfirmProps) {
  const [force, setForce] = useState(false);

  function handleConfirm() {
    onConfirm(force);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tạo bài tập bằng AI</DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {chunk.summary} · {formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="text-sm">
            <p className="text-muted-foreground text-xs mb-1">Theo cấu hình:</p>
            <p className="font-medium">{describeConfig(chunk.interactionConfig, defaultConfig)}</p>
          </div>

          {existingCount > 0 && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm">Xóa {existingCount} bài tập hiện có trước</span>
            </label>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={() => { onClose(); onOpenConfig(); }}>
            Đổi cấu hình
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Hủy</Button>
          <Button size="sm" onClick={handleConfirm} className="gap-1">
            <SparklesIcon className="size-3.5" />
            Tạo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Lesson-wide mode ──────────────────────────────────────────────────────────

interface LessonConfirmProps {
  open: boolean;
  onClose: () => void;
  chunks: TranscriptChunk[];
  totalExisting: number;
  defaultConfig?: ChunkInteractionConfig;
  onConfirm: (force: boolean) => void;
}

export function LessonGenerateConfirmModal({ open, onClose, chunks, totalExisting, defaultConfig, onConfirm }: LessonConfirmProps) {
  const [force, setForce] = useState(false);

  function handleConfirm() {
    onConfirm(force);
    onClose();
  }

  const totalWillGenerate = chunks.reduce((sum, c) => sum + (c.interactionConfig?.count || defaultConfig?.count || 2), 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tạo bài tập cho toàn lesson</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
            {chunks.map((c) => (
              <div key={c.id} className="text-xs flex gap-2">
                <span className="text-muted-foreground shrink-0">
                  {formatTime(c.startSeconds)}–{formatTime(c.endSeconds)}
                </span>
                <span className="text-foreground truncate">{describeConfig(c.interactionConfig, defaultConfig)}</span>
              </div>
            ))}
          </div>
          <p className="text-sm font-medium">Tổng: {totalWillGenerate} bài tập sẽ được tạo.</p>

          {totalExisting > 0 && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm">Xóa toàn bộ {totalExisting} bài tập hiện có trước</span>
            </label>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Hủy</Button>
          <Button size="sm" onClick={handleConfirm} className="gap-1">
            <SparklesIcon className="size-3.5" />
            Tạo tất cả
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
