"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SparklesIcon, Loader2Icon, RefreshCwIcon, LockIcon, SettingsIcon,
} from "lucide-react";
import type { TranscriptChunk, TranscriptSegment, ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { ChunkInteractionsCard } from "./chunk-interactions-card";

// ── Types mirrored from analyze-button ───────────────────────────────────────

type GenPhase =
  | { phase: "idle" }
  | { phase: "running"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  lessonId: string;
  chunks: TranscriptChunk[];
  segments: TranscriptSegment[];
  initialInteractions: LessonInteraction[];
  token: string;
  disabled: boolean;
  genState: GenPhase;
  genWarnings: string[];
  questionsGenerated: boolean;
  feedbackMode: FeedbackMode;
  savingFeedback: boolean;
  onFeedbackModeChange: (mode: FeedbackMode) => void;
  onGenerateLesson: (force?: boolean) => void;
  onInteractionsChange: (interactions: LessonInteraction[]) => void;
  defaultInteractionConfig?: ChunkInteractionConfig;
}

// ── Tab exercises ─────────────────────────────────────────────────────────────

export function TabExercises({
  lessonId, chunks, initialInteractions, token, disabled,
  genState, genWarnings, questionsGenerated,
  feedbackMode, savingFeedback, onFeedbackModeChange,
  onGenerateLesson, onInteractionsChange,
}: Props) {
  const [interactions, setInteractions] = useState<LessonInteraction[]>(initialInteractions);

  function updateInteractions(updated: LessonInteraction[]) {
    setInteractions(updated);
    onInteractionsChange(updated);
  }

  function handleUpdate(it: LessonInteraction) {
    updateInteractions(interactions.map((x) => (x.id === it.id ? it : x)));
  }

  function handleDelete(id: string) {
    updateInteractions(interactions.filter((x) => x.id !== id));
  }

  function handleAdd(it: LessonInteraction) {
    updateInteractions([...interactions, it]);
  }

  const isGenerating = genState.phase === "running";
  const hasChunks = chunks.length > 0;
  const totalInteractions = interactions.length;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Header ── */}
      <div className="rounded-md border border-border bg-muted/20 p-3 flex flex-col gap-3">
        {/* Summary + feedback mode */}
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted-foreground flex-1">
            {hasChunks
              ? `${totalInteractions} bài tập trong ${chunks.length} phân đoạn`
              : "Chưa có phân đoạn — vào tab Phân đoạn video để phân đoạn trước"}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">Phản hồi:</span>
            <select
              value={feedbackMode}
              disabled={savingFeedback}
              onChange={(e) => onFeedbackModeChange(Number(e.target.value) as FeedbackMode)}
              className="text-xs rounded border border-input bg-background px-1.5 py-0.5 text-foreground disabled:opacity-50"
            >
              <option value={FeedbackMode.HIDDEN}>Ẩn</option>
              <option value={FeedbackMode.AFTER_SUBMIT}>Sau khi nộp</option>
              <option value={FeedbackMode.AFTER_EACH}>Sau mỗi câu</option>
            </select>
          </div>
        </div>

        {/* Action row */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={questionsGenerated ? "outline" : "default"}
            size="sm"
            disabled={disabled || !hasChunks}
            onClick={() => onGenerateLesson(questionsGenerated)}
            className="gap-2"
            data-testid="generate-all-btn"
          >
            {isGenerating
              ? <Loader2Icon className="size-4 animate-spin" />
              : questionsGenerated
                ? <RefreshCwIcon className="size-4" />
                : <SparklesIcon className="size-4" />}
            {isGenerating ? "Đang tạo…" : questionsGenerated ? "Tạo lại toàn lesson" : "Tạo AI toàn lesson"}
          </Button>

          {/* Lesson default config — stub button, wired in Step 5 */}
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" disabled={disabled}>
            <SettingsIcon className="size-4" />
            Cấu hình mặc định
          </Button>

          {!hasChunks && (
            <span className="text-xs text-muted-foreground border border-border/50 rounded px-1.5 py-px flex items-center gap-1">
              <LockIcon className="size-2.5" /> Cần phân đoạn trước
            </span>
          )}
        </div>

        {/* Generate progress */}
        {genState.phase === "running" && (
          <p className="text-xs text-muted-foreground">
            {genState.message}
            {genState.totalChunks > 0 && ` (${genState.chunkIndex + 1}/${genState.totalChunks})`}
          </p>
        )}
        {genState.phase === "done" && (
          <p className="text-xs text-green-700 dark:text-green-400 font-medium" data-testid="gen-done">
            {genWarnings.length > 0
              ? `Hoàn thành (${genWarnings.length} đoạn gặp lỗi)`
              : "Câu hỏi đã được tạo thành công!"}
          </p>
        )}
        {genWarnings.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {genWarnings.map((w, i) => (
              <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">{w}</p>
            ))}
          </div>
        )}
        {genState.phase === "error" && (
          <p className="text-xs text-destructive" data-testid="gen-error">{genState.message}</p>
        )}
      </div>

      {/* ── Chunk cards ── */}
      {hasChunks ? (
        <div className="flex flex-col gap-2">
          {chunks.map((chunk, i) => {
            const chunkInteractions = interactions.filter((it) => it.chunkId === chunk.id);
            const defaultOpen = i < 2 || chunks.length <= 3;
            return (
              <ChunkInteractionsCard
                key={chunk.id}
                chunk={chunk}
                chunkInteractions={chunkInteractions}
                lessonId={lessonId}
                token={token}
                disabled={disabled}
                defaultOpen={defaultOpen}
                onInteractionUpdate={handleUpdate}
                onInteractionDelete={handleDelete}
                onInteractionAdd={handleAdd}
                onOpenConfig={() => {/* Step 5 */}}
                onGenerateChunk={() => {/* Step 5 */}}
              />
            );
          })}

          {/* Orphan interactions (no chunkId) */}
          {(() => {
            const orphans = interactions.filter((it) => !it.chunkId || !chunks.some((c) => c.id === it.chunkId));
            if (orphans.length === 0) return null;
            return (
              <div className="rounded-md border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground mb-2">Bài tập không thuộc phân đoạn nào ({orphans.length})</p>
                <div className="flex flex-col gap-2">
                  {orphans.map((it, i) => (
                    <div key={it.id} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{i + 1}.</span>
                      <p className="text-sm flex-1">{it.prompt}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Vào tab <strong>Phân đoạn video</strong> để phân đoạn transcript trước khi tạo bài tập.
          </p>
        </div>
      )}
    </div>
  );
}
