"use client";

import React from "react";
import { CheckCircleIcon, Loader2Icon } from "lucide-react";
import { LessonTaskStatus, type LessonTask } from "buf/gen/richter/v1/ai_pb";
import { cn } from "@/lib/utils";

const STAGES = [
  { step: "TRANSCRIBING", label: "Phiên âm" },
  { step: "CHUNKING", label: "Phân đoạn" },
  { step: "GENERATING", label: "Tạo bài tập" },
] as const;

/**
 * Read-only auto-progress card for a single durable RUN_PIPELINE task (the one
 * Quick Create starts). The server runs every stage on its own; this just shows
 * which stage is live — the user does not click anything. It survives refresh /
 * tab-switch because the state lives in the task row (polled by the parent).
 */
export function PipelineAutoProgressCard({ task }: { task: LessonTask }) {
  const progressStep = task.progressStep ?? "";
  const running = task.status === LessonTaskStatus.RUNNING || task.status === LessonTaskStatus.QUEUED;
  const currentIdx = STAGES.findIndex((s) => s.step === progressStep);

  function stageStatus(i: number): "done" | "active" | "pending" {
    if (currentIdx < 0) return running && i === 0 ? "active" : "pending";
    if (i < currentIdx) return "done";
    if (i === currentIdx) return running ? "active" : "done";
    return "pending";
  }

  return (
    <div className="rounded-xl border bg-card p-4 flex flex-col gap-3" data-testid="pipeline-auto-progress">
      <div className="flex items-center gap-2 flex-wrap">
        <Loader2Icon className="size-4 animate-spin text-primary" />
        <h3 className="text-sm font-semibold">Đang xử lý tự động</h3>
        <span className="text-xs text-muted-foreground">
          Hệ thống tự chạy lần lượt các bước — bạn không cần thao tác gì.
        </span>
      </div>

      <div className="flex items-center gap-2">
        {STAGES.map((stage, i) => {
          const st = stageStatus(i);
          return (
            <React.Fragment key={stage.step}>
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div
                  className={cn(
                    "size-8 rounded-full flex items-center justify-center border-2 transition-all",
                    st === "done" && "border-emerald-500 bg-emerald-50 dark:bg-emerald-950 text-emerald-600",
                    st === "active" && "border-primary bg-primary/10 text-primary",
                    st === "pending" && "border-muted-foreground/30 bg-muted/30 text-muted-foreground",
                  )}
                >
                  {st === "done" ? (
                    <CheckCircleIcon className="size-4" />
                  ) : st === "active" ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <span className="text-xs font-bold">{i + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    "text-xs font-medium truncate w-full text-center",
                    st === "done" && "text-emerald-600",
                    st === "active" && "text-primary font-semibold",
                    st === "pending" && "text-muted-foreground",
                  )}
                >
                  {stage.label}
                </span>
              </div>
              {i < STAGES.length - 1 && (
                <div
                  className={cn(
                    "h-px flex-1 transition-all",
                    stageStatus(i + 1) !== "pending" ? "bg-emerald-400" : "bg-muted-foreground/20",
                  )}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {task.message && <p className="text-xs text-muted-foreground">{task.message}</p>}
    </div>
  );
}
