"use client";

import React, { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Loader2Icon, CheckIcon, XIcon,
  ChevronRightIcon, ChevronDownIcon, RefreshCwIcon, MergeIcon, Trash2Icon,
  PencilIcon, LockIcon, ScissorsIcon, ArrowUpIcon, ArrowDownIcon, PlayIcon,
  FileTextIcon, ListTreeIcon, SparklesIcon, EyeIcon, AlertCircleIcon,
  VideoIcon,
} from "lucide-react";
import {
  AnalysisProgressStep, AnalysisStatus, GenerateInteractionsStep, AIService,
} from "buf/gen/richter/v1/ai_pb";
import type { TranscriptChunk, TranscriptSegment, ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";
import { TabExercises } from "./tab-exercises";
import { VideoUpload } from "./video-upload";

// ── Step progress helpers ─────────────────────────────────────────────────────

const EXTRACT_STEPS = [
  { step: AnalysisProgressStep.DOWNLOADING, label: "Tải video từ storage" },
  { step: AnalysisProgressStep.UPLOADING, label: "Trích xuất âm thanh" },
  { step: AnalysisProgressStep.ANALYZING, label: "Phiên âm bằng Whisper" },
  { step: AnalysisProgressStep.SAVING, label: "Lưu kết quả" },
] as const;

const CHUNK_STEPS = [
  { step: AnalysisProgressStep.ANALYZING, label: "Phân tích nội dung với Gemini" },
  { step: AnalysisProgressStep.SAVING, label: "Lưu các đoạn" },
] as const;

type StepState = "pending" | "active" | "done" | "error";

type StreamRunState =
  | { phase: "idle" }
  | { phase: "syncing" }
  | { phase: "running"; currentStep: AnalysisProgressStep | null }
  | { phase: "done" }
  | { phase: "error"; failedAt: AnalysisProgressStep | null; message: string };

function getStepState(step: AnalysisProgressStep, run: StreamRunState): StepState {
  if (run.phase === "idle" || run.phase === "syncing") return "pending";
  if (run.phase === "done") return "done";
  if (run.phase === "error") {
    if (run.failedAt === null || step < run.failedAt) return "done";
    if (step === run.failedAt) return "error";
    return "pending";
  }
  const cur = run.currentStep;
  if (cur === null) return "pending";
  if (step < cur) return "done";
  if (step === cur) return "active";
  return "pending";
}

type GenRunState =
  | { phase: "idle" }
  | { phase: "running"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

// ── Workflow types ────────────────────────────────────────────────────────────

type WorkflowStepKey = "upload" | "transcript" | "chunks" | "exercises" | "preview";
type WorkflowContentStepKey = Extract<WorkflowStepKey, "upload" | "transcript" | "chunks" | "exercises">;
type WorkflowStatus = "locked" | "ready" | "active" | "running" | "done" | "error";

// ── Workflow task wrapper ─────────────────────────────────────────────────────

type PipelineStepStatus = "locked" | "available" | "active" | "done" | "error";

// ── Shared sub-components ─────────────────────────────────────────────────────

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatStepDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

const stepColors: Record<StepState, string> = {
  done: "bg-green-500/20 text-green-600 dark:text-green-400",
  active: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  error: "bg-destructive/20 text-destructive",
  pending: "bg-muted text-muted-foreground",
};
const labelColors: Record<StepState, string> = {
  done: "text-green-700 dark:text-green-400",
  active: "text-foreground font-medium",
  error: "text-destructive",
  pending: "text-muted-foreground",
};

function ProgressStrip({
  steps,
  runState,
  stepTimings,
  now,
}: {
  steps: readonly { step: AnalysisProgressStep; label: string }[];
  runState: StreamRunState;
  stepTimings: Partial<Record<number, { start: number; end?: number }>>;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-1.5 ml-0.5" data-testid="stream-progress">
      {steps.map(({ step, label }) => {
        const state = getStepState(step, runState);
        const timing = stepTimings[step];
        let durationLabel: string | null = null;
        if (timing) {
          if (timing.end) durationLabel = formatStepDuration(timing.end - timing.start);
          else if (state === "active") durationLabel = formatStepDuration(now - timing.start);
        }
        return (
          <div key={step} className="flex items-center gap-2 text-xs">
            <span className={`size-4 flex items-center justify-center rounded-full shrink-0 ${stepColors[state]}`}>
              {state === "done" ? <CheckIcon className="size-2.5" /> :
               state === "active" ? <Loader2Icon className="size-2.5 animate-spin" /> :
               state === "error" ? <XIcon className="size-2.5" /> :
               <span className="size-1.5 rounded-full bg-current inline-block" />}
            </span>
            <span className={labelColors[state]}>{label}</span>
            {durationLabel && (
              <span className="ml-auto tabular-nums text-muted-foreground">{durationLabel}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Segment editor row ────────────────────────────────────────────────────────

interface SegmentRowProps {
  segment: TranscriptSegment;
  index: number;
  lessonId: string;
  onUpdated: (index: number, text: string) => void;
  onSaved?: () => void;
  disabled: boolean;
  aiClient: ReturnType<typeof useRichterWebClient<typeof AIService>>;
}

function SegmentRow({ segment, index, lessonId, onUpdated, onSaved, disabled, aiClient }: SegmentRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  function handleSave() {
    if (draft.trim() === segment.text) { setEditing(false); return; }
    setSaveError(null);
    startSaving(async () => {
      try {
        await aiClient.updateTranscriptSegment({ lessonId, segmentIndex: index, text: draft.trim() });
        onUpdated(index, draft.trim());
        setEditing(false);
        onSaved?.();
      } catch (err) {
        setSaveError(err instanceof ConnectError ? err.message : "Không thể lưu — thử lại");
      }
    });
  }

  return (
    <div className="flex gap-2 items-start rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
      <span className="text-muted-foreground shrink-0 tabular-nums pt-0.5">
        {formatTime(segment.startSeconds)}
      </span>
      <div className="flex-1 min-w-0">
        {editing ? (
          <>
            <textarea
              autoFocus
              className="w-full resize-none rounded border border-input bg-background px-1.5 py-1 text-xs text-foreground focus:outline-none"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setDraft(segment.text); setEditing(false); setSaveError(null); }
              }}
            />
            {saveError && <p className="text-xs text-destructive mt-0.5">{saveError}</p>}
          </>
        ) : (
          <p className="text-foreground leading-relaxed">{segment.text}</p>
        )}
      </div>
      {!disabled && (
        editing ? (
          <Button
            variant="ghost" size="icon" className="size-6 shrink-0"
            disabled={saving} onClick={handleSave} title="Lưu"
          >
            {saving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
          </Button>
        ) : (
          <Button
            variant="ghost" size="icon" className="size-6 shrink-0"
            onClick={() => setEditing(true)} title="Chỉnh sửa"
          >
            <PencilIcon className="size-3" />
          </Button>
        )
      )}
    </div>
  );
}

// ── Chunk helpers ─────────────────────────────────────────────────────────────

function getChunkSegments(chunk: TranscriptChunk, allSegments: TranscriptSegment[]): TranscriptSegment[] {
  return allSegments.filter(s =>
    s.startSeconds >= chunk.startSeconds &&
    s.startSeconds < chunk.endSeconds
  );
}

// ── Coherence badge ───────────────────────────────────────────────────────────
// Score is computed and persisted server-side (see richter coherence.go) and
// arrives on the chunk proto as `coherence_score` ∈ [0, 1].

function CoherenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 35
    ? "text-green-700 dark:text-green-400 border-green-300 dark:border-green-800"
    : pct >= 20
    ? "text-yellow-700 dark:text-yellow-400 border-yellow-300 dark:border-yellow-800"
    : "text-red-700 dark:text-red-400 border-red-300 dark:border-red-800";
  return (
    <span
      data-testid="coherence-badge"
      data-score={pct}
      className={`text-xs border rounded px-1.5 py-px font-mono ${color}`}
      title="Mức độ gắn kết nội dung (tỉ lệ từ trong mỗi câu thuộc về vốn từ chủ đề chung của đoạn)"
    >
      {pct}%
    </span>
  );
}

// ── Chunk editor ──────────────────────────────────────────────────────────────

interface ChunkEditorProps {
  chunk: TranscriptChunk;
  chunkSegments: TranscriptSegment[];
  prevChunkId: string | null;
  nextChunkId: string | null;
  onMergeWithPrev: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDelete: (id: string) => void;
  onSplit: (id: string, splitAtSeconds: number) => void;
  onMoveSegment: (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) => void;
  isMerging: boolean;
  isDeleting: boolean;
  isSplitting: boolean;
  isMoving: boolean;
  disabled: boolean;
}

function ChunkEditor({
  chunk, chunkSegments, prevChunkId, nextChunkId,
  onMergeWithPrev, onMergeWithNext, onDelete, onSplit, onMoveSegment,
  isMerging, isDeleting, isSplitting, isMoving, disabled,
}: ChunkEditorProps) {
  const busy = disabled || isMerging || isDeleting || isSplitting || isMoving;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/20 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-muted/40 cursor-pointer hover:bg-muted/60 transition-colors group"
        onClick={() => {
          const ev = new CustomEvent("seek-video", { detail: { seconds: chunk.startSeconds } });
          window.dispatchEvent(ev);
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <PlayIcon className="size-3 text-primary shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" />
            <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">{chunk.summary}</p>
          </div>
          <p className="text-xs text-muted-foreground">{formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}</p>
        </div>
        {chunkSegments.length > 0 && <CoherenceBadge score={chunk.coherenceScore} />}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {prevChunkId && (
            <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs h-6"
              disabled={busy} onClick={(e) => { e.stopPropagation(); onMergeWithPrev(chunk.id); }} title="Gộp với đoạn trước">
              {isMerging ? <Loader2Icon className="size-3 animate-spin" /> : <MergeIcon className="size-3" />}
              Gộp lên
            </Button>
          )}
          {nextChunkId && (
            <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs h-6"
              disabled={busy} onClick={(e) => { e.stopPropagation(); onMergeWithNext(chunk.id); }} title="Gộp với đoạn sau">
              {isMerging ? <Loader2Icon className="size-3 animate-spin" /> : <MergeIcon className="size-3" />}
              Gộp xuống
            </Button>
          )}
          <Button variant="ghost" size="sm"
            className="gap-1 px-2 text-xs h-6 text-destructive hover:text-destructive"
            disabled={busy} onClick={(e) => { e.stopPropagation(); onDelete(chunk.id); }}>
            {isDeleting ? <Loader2Icon className="size-3 animate-spin" /> : <Trash2Icon className="size-3" />}
            Xoá
          </Button>
        </div>
      </div>
      {chunkSegments.length > 0 && (
        <div className="flex flex-col divide-y divide-border/50 px-1 pb-1">
          {chunkSegments.map((seg, i) => {
            const isFirstSeg = i === 0;
            const isLastSeg = i === chunkSegments.length - 1;
            const nextSegStart = !isLastSeg ? chunkSegments[i + 1].startSeconds : null;
            return (
              <div
                key={seg.startSeconds}
                className="flex items-start gap-2 px-2 py-1.5 text-xs group cursor-pointer hover:bg-muted/10 transition-colors rounded-sm"
                onClick={() => {
                  const ev = new CustomEvent("seek-video", { detail: { seconds: seg.startSeconds } });
                  window.dispatchEvent(ev);
                }}
              >
                <span className="text-muted-foreground tabular-nums shrink-0 pt-0.5">{formatTime(seg.startSeconds)}</span>
                <p className="flex-1 text-foreground leading-relaxed">{seg.text}</p>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {isFirstSeg && prevChunkId && !isLastSeg && (
                    <Button variant="ghost" size="sm"
                      className="px-1 text-xs h-5"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); onMoveSegment(prevChunkId, chunk.id, nextSegStart ?? chunk.endSeconds, chunk.id); }}
                      title="Chuyển lên đoạn trước">
                      {isMoving ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowUpIcon className="size-3" />}
                    </Button>
                  )}
                  {isLastSeg && nextChunkId && (
                    <Button variant="ghost" size="sm"
                      className="px-1 text-xs h-5"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); onMoveSegment(chunk.id, nextChunkId, seg.startSeconds, chunk.id); }}
                      title="Chuyển xuống đoạn sau">
                      {isMoving ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowDownIcon className="size-3" />}
                    </Button>
                  )}
                  {!isFirstSeg && (
                    <Button variant="ghost" size="sm"
                      className="gap-1 px-1.5 text-xs h-5"
                      disabled={busy} onClick={(e) => { e.stopPropagation(); onSplit(chunk.id, seg.startSeconds); }}
                      title="Tách chunk tại đây">
                      {isSplitting ? <Loader2Icon className="size-3 animate-spin" /> : <ScissorsIcon className="size-3" />}
                      Tách
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Workflow shell ────────────────────────────────────────────────────────────

const workflowStatusClass: Record<WorkflowStatus, string> = {
  locked: "border-border bg-muted/40 text-muted-foreground",
  ready: "border-border bg-background text-foreground",
  active: "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  running: "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  done: "border-green-500 bg-green-500/10 text-green-700 dark:text-green-300",
  error: "border-destructive bg-destructive/10 text-destructive",
};

function WorkflowStepIcon({ status, icon }: { status: WorkflowStatus; icon: React.ReactNode }) {
  if (status === "done") return <CheckIcon className="size-3.5" />;
  if (status === "error") return <XIcon className="size-3.5" />;
  if (status === "running") return <Loader2Icon className="size-3.5 animate-spin" />;
  if (status === "locked") return <LockIcon className="size-3.5" />;
  return icon;
}

function VideoProcessingStepper({
  steps,
  currentStep,
  onSelect,
}: {
  steps: {
    key: WorkflowStepKey;
    title: string;
    subtitle: string;
    status: WorkflowStatus;
    icon: React.ReactNode;
    targetStep?: WorkflowContentStepKey;
  }[];
  currentStep: WorkflowContentStepKey;
  onSelect: (step: { key: WorkflowStepKey; status: WorkflowStatus; targetStep?: WorkflowContentStepKey }) => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/45 backdrop-blur-md p-3 shadow-md transition-all duration-300" data-testid="video-workflow-stepper">
      <div className="grid gap-3 md:grid-cols-5">
        {steps.map((step) => {
          const disabled = step.status === "locked";
          const actionable = !disabled && (step.targetStep || step.key === "preview");
          const active = step.status === "active" || step.status === "running" || step.key === currentStep;
          const isRunning = step.status === "running";

          return (
            <button
              key={step.key}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (actionable) onSelect(step);
              }}
              aria-current={active ? "step" : undefined}
              aria-disabled={!actionable ? true : undefined}
              data-testid={`workflow-step-${step.key}`}
              className={[
                "flex min-w-0 items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-all duration-300 relative overflow-hidden",
                workflowStatusClass[step.status],
                active ? "ring-2 ring-primary/45 bg-primary/5 dark:bg-primary/10 border-primary/40 shadow-sm" : "border-border/60",
                isRunning ? "animate-pulse shadow-[0_0_12px_rgba(59,130,246,0.35)] dark:shadow-[0_0_12px_rgba(59,130,246,0.2)] border-blue-500 dark:border-blue-400 bg-blue-500/5" : "",
                disabled ? "cursor-not-allowed opacity-40 grayscale-[30%]" : actionable ? "hover:bg-muted/40 hover:border-muted-foreground/30 hover:scale-[1.01] active:scale-[0.99] cursor-pointer" : "cursor-default",
              ].join(" ")}
            >
              {/* Glowing highlight indicator for active steps */}
              {active && (
                <span className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-blue-500 to-indigo-500 rounded-r-md" />
              )}

              <span className={[
                "flex size-8 shrink-0 items-center justify-center rounded-full border bg-background/80 transition-all duration-300 shadow-sm",
                active ? "border-primary/40 bg-gradient-to-br from-primary/10 to-indigo-500/10 text-primary" : "border-border/80",
                isRunning ? "animate-spin-slow ring-2 ring-blue-400/30 text-blue-500 dark:text-blue-400" : "",
              ].join(" ")}>
                <WorkflowStepIcon status={step.status} icon={step.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground/80 mb-0.5">Bước {steps.indexOf(step) + 1}</span>
                <span className="block truncate text-sm font-semibold tracking-tight text-foreground">{step.title}</span>
                <span className="block truncate text-xs font-medium text-muted-foreground opacity-90">{step.subtitle}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowActionPanel({
  title,
  description,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  secondaryLabel,
  onSecondary,
  tone = "default",
}: {
  title: string;
  description: string;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  tone?: "default" | "success" | "warning" | "error";
}) {
  const toneClass = {
    default: "border-border bg-muted/20",
    success: "border-green-500/40 bg-green-500/10",
    warning: "border-amber-500/40 bg-amber-500/10",
    error: "border-destructive/40 bg-destructive/10",
  }[tone];

  return (
    <div className={`rounded-md border p-3 ${toneClass}`} data-testid="workflow-next-action">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {secondaryLabel && onSecondary && (
            <Button variant="outline" size="sm" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          )}
          <Button size="sm" disabled={primaryDisabled} onClick={onPrimary}>
            {primaryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkflowStatusSummary({
  tone,
  title,
  description,
  technicalDetail,
  testId,
}: {
  tone: "success" | "warning" | "error";
  title: string;
  description: string;
  technicalDetail?: string;
  testId?: string;
}) {
  const toneClass = {
    success: "border-green-500/40 bg-green-500/10 text-green-800 dark:text-green-300",
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
  }[tone];

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${toneClass}`} data-testid={testId}>
      <div className="flex items-start gap-2">
        {tone === "success" ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> :
          tone === "warning" ? <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" /> :
          <XIcon className="mt-0.5 size-3.5 shrink-0" />}
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <p className="mt-0.5 opacity-90">{description}</p>
          {technicalDetail && (
            <details className="mt-1">
              <summary className="cursor-pointer font-medium">Chi tiết lỗi</summary>
              <p className="mt-1 break-words font-mono opacity-80">{technicalDetail}</p>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowReadyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-border/70 bg-muted/10 px-4 py-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  );
}

function WorkflowStepPanel({
  stepNumber,
  title,
  description,
  children,
}: {
  stepNumber: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border bg-background" data-testid="workflow-step-body">
      <div className="border-b px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-semibold">
            {stepNumber}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>
      <div className="p-4">
        {children}
      </div>
    </section>
  );
}

function WorkflowTaskSection({
  title,
  status,
  optional = false,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title: string;
  status?: PipelineStepStatus;
  optional?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const state = status ?? "available";
  const locked = state === "locked";
  const iconClass = {
    locked: "border-muted-foreground/30 bg-muted text-muted-foreground",
    available: "border-border bg-background text-muted-foreground",
    active: "border-blue-500 bg-blue-500 text-white",
    done: "border-green-500 bg-green-500 text-white",
    error: "border-destructive bg-destructive text-white",
  }[state];

  return (
    <section className="rounded-md border bg-muted/10 p-3">
      <div className="flex min-h-7 items-center gap-2">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${iconClass}`}>
          {state === "done" ? <CheckIcon className="size-3.5" /> :
            state === "error" ? <XIcon className="size-3.5" /> :
            state === "active" ? <Loader2Icon className="size-3.5 animate-spin" /> :
            state === "locked" ? <LockIcon className="size-3" /> :
            <ChevronRightIcon className="size-3.5" />}
        </span>
        <h4 className={`text-sm font-medium ${locked ? "text-muted-foreground" : "text-foreground"}`}>
          {title}
        </h4>
        {optional && (
          <span className="rounded border border-border/50 px-1.5 py-px text-xs text-muted-foreground">
            Tuỳ chọn
          </span>
        )}
        {collapsible && !locked && (
          <button
            type="button"
            className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(o => !o)}
            aria-label={open ? "Thu gọn" : "Mở rộng"}
          >
            {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </button>
        )}
      </div>
      {!locked && (!collapsible || open) && (
        <div className="mt-3">
          {children}
        </div>
      )}
    </section>
  );
}

function getInitialWorkflowStep(
  hasVideo: boolean,
  segments: TranscriptSegment[],
  chunks: TranscriptChunk[],
  interactions: LessonInteraction[],
  transcript: string,
  status?: AnalysisStatus,
): WorkflowContentStepKey {
  if (!hasVideo) return "upload";
  if (chunks.length > 0 || interactions.length > 0 || status === AnalysisStatus.DONE) return "exercises";
  if (segments.length > 0 || transcript.trim() || status === AnalysisStatus.TRANSCRIPT_EXTRACTED) return "chunks";
  return "transcript";
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  lessonId: string;
  initialChunks?: TranscriptChunk[];
  initialSegments?: TranscriptSegment[];
  initialTranscript?: string;
  initialStatus?: AnalysisStatus;
  initialErrorMsg?: string;
  initialInteractions?: LessonInteraction[];
  initialFeedbackMode?: FeedbackMode;
  initialDefaultInteractionConfig?: ChunkInteractionConfig;
  initialLanguage?: string;
  initialMaxAttempts?: number;
  title: string;
  description: string;
  orderIndex: number;
  token: string;

  // New props for integrating VideoUpload
  videoStorageKey?: string;
  moduleId: string;
  courseId: string;
  slug: string;
}

export function AnalyzeButton({
  lessonId,
  initialChunks = [],
  initialSegments = [],
  initialTranscript = "",
  initialStatus,
  initialErrorMsg,
  initialInteractions = [],
  initialFeedbackMode = FeedbackMode.AFTER_SUBMIT,
  initialDefaultInteractionConfig,
  initialLanguage = "vi",
  initialMaxAttempts = 0,
  title,
  description,
  orderIndex,
  token,
  videoStorageKey,
  moduleId,
  courseId,
  slug,
}: Props) {
  const router = useRouter();
  const aiClient = useRichterWebClient(AIService, token);
  const lessonClient = useRichterWebClient(LessonService, token);
  const [feedbackMode, setFeedbackMode] = useState<FeedbackMode>(initialFeedbackMode);
  const [savingFeedback, startSaveFeedback] = useTransition();
  const [language, setLanguage] = useState<string>(initialLanguage);
  const [savingLanguage, startSaveLanguage] = useTransition();
  const [maxAttempts, setMaxAttempts] = useState<number>(initialMaxAttempts);
  const [savingMaxAttempts, startSaveMaxAttempts] = useTransition();

  function handleLanguageChange(lang: string) {
    setLanguage(lang);
    startSaveLanguage(async () => {
      try {
        await lessonClient.updateLesson({
          id: lessonId,
          title,
          description,
          orderIndex,
          language: lang,
          maxAttempts,
        });
      } catch {
        setLanguage(language);
      }
    });
  }

  function handleMaxAttemptsChange(val: number) {
    setMaxAttempts(val);
    startSaveMaxAttempts(async () => {
      try {
        await lessonClient.updateLesson({
          id: lessonId,
          title,
          description,
          orderIndex,
          language,
          maxAttempts: val,
        });
      } catch {
        setMaxAttempts(maxAttempts);
      }
    });
  }
  const abortRef = useRef<AbortController | null>(null);

  const [activeStep, setActiveStep] = useState<WorkflowContentStepKey>(() =>
    getInitialWorkflowStep(!!videoStorageKey, initialSegments, initialChunks, initialInteractions, initialTranscript, initialStatus),
  );



  function handleFeedbackModeChange(mode: FeedbackMode) {
    setFeedbackMode(mode);
    startSaveFeedback(async () => {
      try {
        await lessonClient.updateLessonFeedbackMode({ id: lessonId, feedbackMode: mode });
      } catch {
        // revert on failure
        setFeedbackMode(feedbackMode);
      }
    });
  }
  const [status, setStatus] = useState<AnalysisStatus | undefined>(initialStatus);
  const [extractState, setExtractState] = useState<StreamRunState>(() => {
    if (initialStatus === AnalysisStatus.ERROR && initialSegments.length === 0) {
      return { phase: "error", failedAt: null, message: initialErrorMsg || "Thao tác thất bại." };
    }
    if (initialStatus !== AnalysisStatus.PROCESSING) return { phase: "idle" };
    return initialSegments.length > 0 ? { phase: "done" } : { phase: "syncing" };
  });
  const [chunkState, setChunkState] = useState<StreamRunState>(() => {
    if (initialStatus === AnalysisStatus.ERROR && initialSegments.length > 0 && initialChunks.length === 0) {
      return { phase: "error", failedAt: null, message: initialErrorMsg || "Thao tác thất bại." };
    }
    if (initialStatus === AnalysisStatus.PROCESSING && initialSegments.length > 0 && initialChunks.length === 0) {
      return { phase: "syncing" };
    }
    return { phase: "idle" };
  });
  const [extractTimings, setExtractTimings] = useState<Partial<Record<number, { start: number; end?: number }>>>({});
  const [now, setNow] = useState(() => Date.now());
  const [segments, setSegments] = useState<TranscriptSegment[]>(initialSegments);
  const [chunkTimings, setChunkTimings] = useState<Partial<Record<number, { start: number; end?: number }>>>({});
  const [chunks, setChunks] = useState<TranscriptChunk[]>(initialChunks);
  const [mutatingChunkId, setMutatingChunkId] = useState<string | null>(null);
  const [mutatingOp, setMutatingOp] = useState<"merge" | "delete" | "split" | "move" | null>(null);
  const [genState, setGenState] = useState<GenRunState>(() =>
    initialStatus === AnalysisStatus.ERROR && initialChunks.length > 0
      ? { phase: "error", message: initialErrorMsg || "Thao tác thất bại." }
      : { phase: "idle" },
  );
  const [isReloadingChunks, setIsReloadingChunks] = useState(false);
  const [genWarnings, setGenWarnings] = useState<string[]>([]);
  const [mutatingError, setMutatingError] = useState<string | null>(null);
  const [confirmReExtract, setConfirmReExtract] = useState(false);
  const [interactions, setInteractions] = useState<LessonInteraction[]>(initialInteractions);
  const [exerciseOpenRequest, setExerciseOpenRequest] = useState(0);

  // Sync props to state on RSC refresh
  useEffect(() => {
    setSegments(initialSegments);
  }, [initialSegments]);

  useEffect(() => {
    setChunks(initialChunks);
  }, [initialChunks]);

  useEffect(() => {
    setInteractions(initialInteractions);
  }, [initialInteractions]);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => { return () => { abortRef.current?.abort(); }; }, []);

  // Bug 1 fix: when video is replaced, server resets analysis status to PENDING.
  // React preserves client component state across prop changes, so we must
  // explicitly clear stale pipeline state when initialStatus transitions to PENDING.
  useEffect(() => {
    if (initialStatus !== AnalysisStatus.PENDING && initialStatus !== undefined) return;
    abortRef.current?.abort();
    setSegments([]);
    setChunks([]);
    setInteractions([]);
    setStatus(initialStatus);
    setExtractState({ phase: "idle" });
    setChunkState({ phase: "idle" });
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    setExtractTimings({});
    setChunkTimings({});
    setConfirmReExtract(false);
    setActiveStep(!videoStorageKey ? "upload" : "transcript");
  }, [initialStatus, videoStorageKey]);

  useEffect(() => {
    const isRunning = extractState.phase === "running" || chunkState.phase === "running";
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [extractState.phase, chunkState.phase]);

  const isSyncingExtract = extractState.phase === "syncing";
  const isSyncingChunk = chunkState.phase === "syncing";
  useEffect(() => {
    if (!isSyncingExtract && !isSyncingChunk) return;
    const id = setInterval(async () => {
      try {
        const analysisResult = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
        const analysis = analysisResult?.analysis ?? null;
        const freshChunks = analysisResult?.chunks ?? [];
        if (!analysis || analysis.status === AnalysisStatus.PROCESSING) return;
        clearInterval(id);
        if (
          analysis.status === AnalysisStatus.TRANSCRIPT_EXTRACTED ||
          analysis.status === AnalysisStatus.CHUNKS_READY ||
          analysis.status === AnalysisStatus.DONE
        ) {
          setChunks(freshChunks);
          setSegments(analysis.transcriptSegments);
          setStatus(analysis.status);
          if (isSyncingExtract) setExtractState({ phase: "done" });
          if (isSyncingChunk) setChunkState({ phase: "done" });
          setActiveStep(freshChunks.length > 0 ? "exercises" : "chunks");
          router.refresh();
        } else if (analysis.status === AnalysisStatus.ERROR) {
          const msg = analysis.errorMsg || "Thao tác thất bại.";
          if (isSyncingExtract) setExtractState({ phase: "error", failedAt: null, message: msg });
          if (isSyncingChunk) setChunkState({ phase: "error", failedAt: null, message: msg });
        } else {
          if (isSyncingExtract) setExtractState({ phase: "idle" });
          if (isSyncingChunk) setChunkState({ phase: "idle" });
        }
      } catch {
        // network error — keep polling
      }
    }, 5000);
    return () => clearInterval(id);
  }, [isSyncingExtract, isSyncingChunk, lessonId, router, aiClient]);

  // ── Stream helper ──────────────────────────────────────────────────────────

  function startStream(
    streamCall: (signal: AbortSignal) => AsyncIterable<{ step: number; message: string }>,
    setState: React.Dispatch<React.SetStateAction<StreamRunState>>,
    setTimings: (fn: (p: Partial<Record<number, { start: number; end?: number }>>) => Partial<Record<number, { start: number; end?: number }>>) => void,
    onDone: () => void,
  ) {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setState({ phase: "running", currentStep: null });
    setTimings(() => ({}));
    setNow(Date.now());

    let lastStep: AnalysisProgressStep | null = null;

    (async () => {
      try {
        for await (const event of streamCall(abortController.signal)) {
          if (event.step === AnalysisProgressStep.ERROR) {
            if (lastStep !== null) {
              const t = Date.now();
              setTimings(prev => ({ ...prev, [lastStep!]: { ...prev[lastStep!]!, end: t } }));
            }
            setState({ phase: "error", failedAt: lastStep, message: event.message || "Thao tác thất bại." });
            return;
          }
          if (event.step === AnalysisProgressStep.DONE) {
            if (lastStep !== null) {
              const t = Date.now();
              setTimings(prev => ({ ...prev, [lastStep!]: { ...prev[lastStep!]!, end: t } }));
            }
            setState({ phase: "done" });
            onDone();
            return;
          }
          const newStep = event.step as AnalysisProgressStep;
          if (newStep !== lastStep) {
            const t = Date.now();
            setTimings(prev => {
              const updated = { ...prev };
              if (lastStep !== null && updated[lastStep] && !updated[lastStep]!.end) {
                updated[lastStep] = { ...updated[lastStep]!, end: t };
              }
              if (!updated[newStep]) updated[newStep] = { start: t };
              return updated;
            });
          }
          lastStep = newStep;
          setState({ phase: "running", currentStep: newStep });
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof ConnectError ? err.message : "Mất kết nối với máy chủ.";
        setState(prev =>
          prev.phase === "running"
            ? { phase: "error", failedAt: prev.currentStep, message: msg }
            : prev,
        );
      }
    })();
  }

  // ── Extract ─────────────────────────────────────────────────────────────────

  async function reloadAfterExtract() {
    const analysisResult = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
    const analysis = analysisResult?.analysis ?? null;
    const freshChunks = analysisResult?.chunks ?? [];
    if (analysis) {
      setSegments(analysis.transcriptSegments);
      setChunks(freshChunks);
      setStatus(analysis.status);
    }
    setChunkState({ phase: "idle" });
    setChunkTimings({});
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    setActiveStep(analysis?.transcriptSegments.length ? "chunks" : "transcript");
    router.refresh();
  }

  function startExtract() {
    setConfirmReExtract(false);
    setActiveStep("transcript");
    setChunkState({ phase: "idle" });
    setChunkTimings({});
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    startStream(
      (signal) => aiClient.extractTranscriptStream({ lessonId }, { signal }),
      setExtractState,
      setExtractTimings,
      reloadAfterExtract,
    );
  }

  // ── Re-chunk ─────────────────────────────────────────────────────────────────

  async function reloadChunks() {
    setIsReloadingChunks(true);
    try {
      const res = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(res.chunks);
      setStatus(AnalysisStatus.CHUNKS_READY);
      if (res.chunks.length > 0) setActiveStep("exercises");
    } finally {
      setIsReloadingChunks(false);
    }
  }

  function handleChunk() {
    if (chunkState.phase === "running") return;
    setActiveStep("chunks");
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    startStream(
      (signal) => aiClient.chunkTranscriptStream({ lessonId }, { signal }),
      setChunkState,
      setChunkTimings,
      reloadChunks,
    );
  }

  // ── Chunk mutations ──────────────────────────────────────────────────────────

  async function handleMergeWithPrev(chunkId: string) {
    const idx = chunks.findIndex(c => c.id === chunkId);
    if (idx <= 0) return;
    setMutatingChunkId(chunkId);
    setMutatingOp("merge");
    setMutatingError(null);
    try {
      await aiClient.mergeChunks({ keepChunkId: chunks[idx - 1].id, discardChunkId: chunkId });
      const fresh = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(fresh.chunks);
    } catch (err) {
      setMutatingError(err instanceof ConnectError ? err.message : "Không thể gộp đoạn");
    } finally {
      setMutatingChunkId(null);
      setMutatingOp(null);
    }
  }

  async function handleMergeWithNext(chunkId: string) {
    const idx = chunks.findIndex(c => c.id === chunkId);
    if (idx < 0 || idx >= chunks.length - 1) return;
    setMutatingChunkId(chunkId);
    setMutatingOp("merge");
    setMutatingError(null);
    try {
      await aiClient.mergeChunks({ keepChunkId: chunkId, discardChunkId: chunks[idx + 1].id });
      const fresh = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(fresh.chunks);
    } catch (err) {
      setMutatingError(err instanceof ConnectError ? err.message : "Không thể gộp đoạn");
    } finally {
      setMutatingChunkId(null);
      setMutatingOp(null);
    }
  }

  async function handleMoveSegment(prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) {
    setMutatingChunkId(triggerChunkId);
    setMutatingOp("move");
    setMutatingError(null);
    try {
      await aiClient.adjustChunkBoundary({ prevChunkId, nextChunkId, newBoundarySeconds });
      const fresh = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(fresh.chunks);
    } catch (err) {
      setMutatingError(err instanceof ConnectError ? err.message : "Không thể di chuyển segment");
    } finally {
      setMutatingChunkId(null);
      setMutatingOp(null);
    }
  }

  async function handleDeleteChunk(chunkId: string) {
    setMutatingChunkId(chunkId);
    setMutatingOp("delete");
    setMutatingError(null);
    try {
      await aiClient.deleteChunk({ chunkId });
      const fresh = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(fresh.chunks);
    } catch (err) {
      setMutatingError(err instanceof ConnectError ? err.message : "Không thể xóa đoạn");
    } finally {
      setMutatingChunkId(null);
      setMutatingOp(null);
    }
  }

  async function handleSplitChunk(chunkId: string, splitAtSeconds: number) {
    setMutatingChunkId(chunkId);
    setMutatingOp("split");
    setMutatingError(null);
    try {
      await aiClient.splitChunk({ chunkId, splitAtSeconds });
      const fresh = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(fresh.chunks);
    } catch (err) {
      setMutatingError(err instanceof ConnectError ? err.message : "Không thể tách đoạn");
    } finally {
      setMutatingChunkId(null);
      setMutatingOp(null);
    }
  }

  // ── Generate questions ───────────────────────────────────────────────────────

  async function reloadAfterGenerate() {
    const analysisResult = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
    const analysis = analysisResult?.analysis ?? null;
    if (analysis?.interactions) {
      setInteractions(analysis.interactions);
    }
    if (analysis) setStatus(analysis.status);
    router.refresh();
  }

  function handleGenerate(force?: boolean, chunkId?: string, difficulty?: string, focusPrompt?: string) {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setActiveStep("exercises");
    setGenState({ phase: "running", message: "Đang bắt đầu...", chunkIndex: 0, totalChunks: 0 });
    setGenWarnings([]);

    const shouldForce = force ?? questionsGenerated;

    (async () => {
      try {
        let lastStreamError = "";
        for await (const event of aiClient.generateInteractionsStream(
          {
            lessonId,
            chunkId: chunkId ?? "",
            forceRegenerate: shouldForce,
            difficulty: difficulty ?? "",
            focusPrompt: focusPrompt ?? "",
          },
          { signal: abortController.signal },
        )) {
          if (event.step === GenerateInteractionsStep.ERROR) {
            lastStreamError = event.message || "Lỗi tạo câu hỏi cho một đoạn";
            setGenWarnings(prev => [...prev, lastStreamError]);
            setGenState({ phase: "running", message: `${lastStreamError}...`, chunkIndex: event.chunkIndex, totalChunks: event.totalChunks });
            continue;
          }
          if (event.step === GenerateInteractionsStep.DONE) {
            setGenState({ phase: "done" });
            reloadAfterGenerate();
            return;
          }
          setGenState({ phase: "running", message: event.message, chunkIndex: event.chunkIndex, totalChunks: event.totalChunks });
        }
        setGenState({
          phase: "error",
          message: lastStreamError || "Luồng tạo bài tập kết thúc trước khi hoàn tất.",
        });
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof ConnectError ? err.message : "Mất kết nối với máy chủ.";
        setGenState(prev => prev.phase === "running" ? { phase: "error", message: msg } : prev);
      }
    })();
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  const isExtracting = extractState.phase === "running";
  const isSyncing = extractState.phase === "syncing";
  const isChunking = chunkState.phase === "running";
  const isChunkSyncing = chunkState.phase === "syncing";
  const isGenerating = genState.phase === "running";
  const isMutating = !!mutatingChunkId;
  const isBusy = isExtracting || isChunking || isGenerating || isReloadingChunks || isMutating;

  const hasSegments = segments.length > 0;
  const hasChunks = chunks.length > 0;
  const questionsGenerated = interactions.length > 0;
  const hasTranscriptContent =
    hasSegments ||
    !!initialTranscript.trim() ||
    hasChunks ||
    questionsGenerated ||
    status === AnalysisStatus.TRANSCRIPT_EXTRACTED ||
    status === AnalysisStatus.CHUNKS_READY;
  const shouldShowTranscriptTask = hasTranscriptContent || extractState.phase !== "idle" || confirmReExtract;
  const shouldShowChunkTask = hasChunks || chunkState.phase !== "idle";

  const step2Status: PipelineStepStatus =
    isExtracting || isSyncing ? "active" :
    extractState.phase === "error" ? "error" :
    hasTranscriptContent ? "done" : "available";

  const step3Status: PipelineStepStatus = hasSegments ? "available" : "locked";

  const step4Status: PipelineStepStatus =
    !hasTranscriptContent ? "locked" :
    isChunking || isChunkSyncing ? "active" :
    chunkState.phase === "error" ? "error" :
    hasChunks ? "done" : "available";

  const step5Status: PipelineStepStatus = hasChunks ? "available" : "locked";



  const uploadWorkflowStatus: WorkflowStatus =
    !videoStorageKey ? "active" : "done";

  const transcriptWorkflowStatus: WorkflowStatus =
    !videoStorageKey ? "locked" :
    extractState.phase === "error" ? "error" :
    isExtracting ? "running" :
    hasSegments || hasTranscriptContent ? "done" :
    activeStep === "transcript" ? "active" : "ready";

  const chunkWorkflowStatus: WorkflowStatus =
    !hasTranscriptContent ? "locked" :
    chunkState.phase === "error" ? "error" :
    isChunking ? "running" :
    hasChunks ? "done" :
    activeStep === "chunks" ? "active" : "ready";

  const exerciseWorkflowStatus: WorkflowStatus =
    !hasChunks ? "locked" :
    genState.phase === "error" ? "error" :
    isGenerating ? "running" :
    questionsGenerated ? "done" :
    activeStep === "exercises" ? "active" : "ready";

  const previewWorkflowStatus: WorkflowStatus = (questionsGenerated || interactions.length > 0) ? "ready" : "locked";

  const workflowSteps = [
    {
      key: "upload" as const,
      title: "Tải video",
      subtitle: videoStorageKey ? "Đã tải lên" : "Chờ tải video",
      status: uploadWorkflowStatus,
      icon: <VideoIcon className="size-3.5" />,
      targetStep: "upload" as const,
    },
    {
      key: "transcript" as const,
      title: "Phiên âm",
      subtitle: isExtracting || isSyncing
        ? "Đang xử lý"
        : hasSegments ? `${segments.length} đoạn`
        : hasTranscriptContent ? "Đã có transcript"
        : "Sẵn sàng",
      status: transcriptWorkflowStatus,
      icon: <FileTextIcon className="size-3.5" />,
      targetStep: "transcript" as const,
    },
    {
      key: "chunks" as const,
      title: "Phân đoạn",
      subtitle: isChunking || isChunkSyncing ? "Đang xử lý" : hasChunks ? `${chunks.length} đoạn` : hasTranscriptContent ? "Sẵn sàng" : "Chưa sẵn sàng",
      status: chunkWorkflowStatus,
      icon: <ListTreeIcon className="size-3.5" />,
      targetStep: "chunks" as const,
    },
    {
      key: "exercises" as const,
      title: "Bài tập",
      subtitle: isGenerating ? "Đang tạo" : questionsGenerated ? `${interactions.length} câu` : hasChunks ? "Sẵn sàng" : "Chưa tạo",
      status: exerciseWorkflowStatus,
      icon: <SparklesIcon className="size-3.5" />,
      targetStep: "exercises" as const,
    },
    {
      key: "preview" as const,
      title: "Xem thử",
      subtitle: questionsGenerated ? "Sẵn sàng" : "Chưa sẵn sàng",
      status: previewWorkflowStatus,
      icon: <EyeIcon className="size-3.5" />,
    },
  ];

  function handleWorkflowSelect(step: { key: WorkflowStepKey; status: WorkflowStatus; targetStep?: WorkflowContentStepKey }) {
    if (step.status === "locked") return;
    if (step.key === "preview") {
      router.push("?preview=1");
      return;
    }
    if (step.targetStep) setActiveStep(step.targetStep);
  }

  const workflowAction =
    !videoStorageKey ? {
      title: "Tiếp theo: Tải video bài giảng",
      description: "Cần có video trước khi phiên âm, phân đoạn và tạo bài tập.",
      primaryLabel: "Mở bước tải video",
      onPrimary: () => setActiveStep("upload"),
      tone: "default" as const,
    } :
    extractState.phase === "error" ? {
      title: "Không thể phiên âm video",
      description: "Hãy thử lại hoặc kiểm tra video có âm thanh rõ ràng.",
      primaryLabel: "Thử lại",
      onPrimary: startExtract,
      secondaryLabel: "Mở phiên âm",
      onSecondary: () => setActiveStep("transcript"),
      tone: "error" as const,
    } :
    chunkState.phase === "error" ? {
      title: "Không thể phân đoạn bài học",
      description: "Transcript đã có, nhưng bước chia nội dung gặp lỗi. Bạn có thể thử phân đoạn lại.",
      primaryLabel: hasChunks ? "Phân đoạn lại" : "Phân đoạn bài học",
      onPrimary: () => { setActiveStep("chunks"); handleChunk(); },
      secondaryLabel: "Mở phân đoạn",
      onSecondary: () => setActiveStep("chunks"),
      tone: "error" as const,
    } :
    genState.phase === "error" ? {
      title: "Không thể tạo bài tập",
      description: "Bước tạo bài tập gặp lỗi. Mở phần bài tập để kiểm tra cấu hình và thử lại.",
      primaryLabel: "Mở bài tập",
      onPrimary: () => setActiveStep("exercises"),
      tone: "error" as const,
    } :
    isExtracting || isSyncing ? {
      title: "Đang trích xuất transcript",
      description: "Hệ thống đang lấy âm thanh từ video và phiên âm bằng Whisper.",
      primaryLabel: "Đang trích xuất...",
      onPrimary: () => setActiveStep("transcript"),
      primaryDisabled: true,
      tone: "default" as const,
    } :
    isChunking || isChunkSyncing ? {
      title: "Đang phân đoạn bài học",
      description: "Hệ thống đang chia transcript thành các đoạn học tập có ngữ cảnh rõ ràng.",
      primaryLabel: "Đang phân đoạn...",
      onPrimary: () => setActiveStep("chunks"),
      primaryDisabled: true,
      tone: "default" as const,
    } :
    isGenerating ? {
      title: "Đang tạo bài tập",
      description: "AI đang tạo câu hỏi từ các phân đoạn của bài học.",
      primaryLabel: "Đang tạo...",
      onPrimary: () => setActiveStep("exercises"),
      primaryDisabled: true,
      tone: "default" as const,
    } :
    !hasTranscriptContent ? {
      title: "Tiếp theo: Trích xuất transcript",
      description: "Hệ thống sẽ lấy âm thanh từ video và phiên âm bằng Whisper.",
      primaryLabel: "Trích xuất transcript",
      onPrimary: startExtract,
      tone: "default" as const,
    } :
    !hasChunks ? {
      title: "Tiếp theo: Phân đoạn bài học",
      description: "Transcript đã sẵn sàng. Chia bài học thành các đoạn nhỏ để tạo bài tập đúng ngữ cảnh.",
      primaryLabel: "Phân đoạn bài học",
      onPrimary: () => { setActiveStep("chunks"); handleChunk(); },
      secondaryLabel: "Xem transcript",
      onSecondary: () => setActiveStep("transcript"),
      tone: "default" as const,
    } :
    !questionsGenerated ? {
      title: "Tiếp theo: Tạo bài tập",
      description: `Đã có ${chunks.length} phân đoạn. Chọn số lượng từng loại câu hỏi rồi tạo bài tập.`,
      primaryLabel: "Tạo bài tập",
      onPrimary: () => {
        setActiveStep("exercises");
        setExerciseOpenRequest(n => n + 1);
      },
      secondaryLabel: "Chỉnh phân đoạn",
      onSecondary: () => setActiveStep("chunks"),
      tone: "default" as const,
    } :
    {
      title: "Đã sẵn sàng dùng thử",
      description: "Video, transcript, phân đoạn và bài tập đã được tạo. Bạn có thể xem thử với vai trò học viên.",
      primaryLabel: "Xem thử",
      onPrimary: () => router.push("?preview=1"),
      secondaryLabel: "Tạo thêm bài tập",
      onSecondary: () => {
        setActiveStep("exercises");
        setExerciseOpenRequest(n => n + 1);
      },
      tone: "success" as const,
    };

  const shouldShowWorkflowAction =
    !(activeStep === "upload" && !videoStorageKey) &&
    !(activeStep === "exercises" && hasChunks && genState.phase !== "error" && !isGenerating && !questionsGenerated);

  const activeStepMeta = {
    upload: {
      stepNumber: 1,
      title: "Tải video bài giảng",
      description: videoStorageKey
        ? "Video bài giảng đã được tải lên thành công. Nhấn Tiếp tục để qua bước Phiên âm."
        : "Vui lòng kéo thả hoặc chọn tệp video từ máy tính của bạn để bắt đầu bài giảng.",
    },
    transcript: {
      stepNumber: 2,
      title: "Phiên âm bài giảng",
      description: hasSegments
        ? "Kiểm tra và chỉnh transcript trước khi phân đoạn bài học."
        : "Tạo transcript từ âm thanh video để làm dữ liệu cho các bước tiếp theo.",
    },
    chunks: {
      stepNumber: 3,
      title: "Phân đoạn bài học",
      description: hasChunks
        ? "Rà soát mốc thời gian và chỉnh các đoạn nội dung trước khi tạo bài tập."
        : "Chia transcript thành các đoạn học tập có ngữ cảnh rõ ràng.",
    },
    exercises: {
      stepNumber: 4,
      title: "Tạo bài tập",
      description: questionsGenerated
        ? "Quản lý, chỉnh sửa hoặc tạo thêm bài tập từ các phân đoạn đã có."
        : "Chọn cấu hình câu hỏi và tạo bài tập cho học viên.",
    },
  }[activeStep];

  return (
    <div className="flex flex-col gap-3">
      {/* Settings section */}
      {videoStorageKey && (
        <div className="flex flex-wrap items-center gap-4 border-b pb-3 mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0 font-medium">Ngôn ngữ bài giảng:</span>
            <select
              value={language}
              onChange={(e) => handleLanguageChange(e.target.value)}
              disabled={savingLanguage}
              className="text-xs rounded border border-input bg-background px-2 py-1 focus:ring-1 focus:ring-primary focus:outline-none"
            >
              <option value="vi">🇻🇳 Tiếng Việt</option>
              <option value="en">🇬🇧 English</option>
            </select>
            {savingLanguage && <span className="text-[10px] text-muted-foreground animate-pulse">Đang lưu...</span>}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0 font-medium">Số lượt nộp tối đa:</span>
            <input
              type="number"
              min="0"
              value={maxAttempts}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                handleMaxAttemptsChange(isNaN(val) ? 0 : val);
              }}
              disabled={savingMaxAttempts}
              className="text-xs w-16 rounded border border-input bg-background px-2 py-1 text-center focus:ring-1 focus:ring-primary focus:outline-none"
            />
            <span className="text-[10px] text-muted-foreground">(0 = không giới hạn)</span>
            {savingMaxAttempts && <span className="text-[10px] text-muted-foreground animate-pulse">Đang lưu...</span>}
          </div>
        </div>
      )}

      <VideoProcessingStepper steps={workflowSteps} currentStep={activeStep} onSelect={handleWorkflowSelect} />
      {shouldShowWorkflowAction && <WorkflowActionPanel {...workflowAction} />}

      <WorkflowStepPanel
        stepNumber={activeStepMeta.stepNumber}
        title={activeStepMeta.title}
        description={activeStepMeta.description}
      >
      {activeStep === "upload" && (
        <div className="flex flex-col gap-3">
          <WorkflowTaskSection title="Nguồn video" status={videoStorageKey ? "done" : "active"}>
            <VideoUpload
              lessonId={lessonId}
              moduleId={moduleId}
              courseId={courseId}
              slug={slug}
              hasVideo={!!videoStorageKey}
              token={token}
            />
            {videoStorageKey && (
              <details className="mt-3 rounded-lg border border-border/30 bg-muted/20 px-3 py-2 text-xs text-muted-foreground/80">
                <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">Chi tiết kỹ thuật</summary>
                <p className="mt-2 break-all font-mono text-[10px] bg-background/50 p-1.5 rounded border">Key: {videoStorageKey}</p>
              </details>
            )}
          </WorkflowTaskSection>
        </div>
      )}

      {activeStep === "transcript" && (
        <div className="flex flex-col gap-3 animate-in fade-in duration-200">
          {!videoStorageKey ? (
            <div className="flex flex-col items-center justify-center p-10 text-center border border-dashed border-border/80 rounded-2xl bg-muted/5 shadow-inner">
              <div className="rounded-full bg-muted/20 p-4 border border-border/40 mb-3.5">
                <LockIcon className="size-6 text-muted-foreground animate-pulse" />
              </div>
              <h3 className="text-sm font-semibold text-foreground/90">Tính năng phiên âm chưa sẵn sàng</h3>
              <p className="text-xs text-muted-foreground max-w-sm mt-1.5 leading-relaxed">
                Vui lòng hoàn thành Bước 1: Tải video trước để tải tệp bài giảng lên hệ thống. AI cần tệp video để bắt đầu quá trình trích xuất âm thanh và tự động tạo transcript.
              </p>
            </div>
          ) : (
            <>
              {shouldShowTranscriptTask ? (
                <WorkflowTaskSection title="Tác vụ phiên âm" status={step2Status}>
                  <div className="flex flex-col gap-2">
                    {hasTranscriptContent && !confirmReExtract && (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => {
                          if (hasTranscriptContent) { setConfirmReExtract(true); return; }
                          startExtract();
                        }}
                        className="gap-2 w-fit"
                      >
                        {isExtracting
                          ? <Loader2Icon className="size-4 animate-spin" />
                          : <PlayIcon className="size-4" />}
                        {isExtracting ? "Đang trích xuất..." :
                          hasTranscriptContent ? "Trích xuất lại" : "Trích xuất transcript"}
                      </Button>
                    )}

                    {confirmReExtract && (
                      <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-xs flex flex-col gap-2">
                        <p className="font-medium text-amber-800 dark:text-amber-300">Trích xuất lại transcript?</p>
                        <p className="text-amber-700 dark:text-amber-400">
                          Transcript, phân đoạn và bài tập hiện tại sẽ bị xoá vì chúng gắn với video cũ.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm" variant="destructive" className="h-6 text-xs px-2"
                            onClick={() => startExtract()}
                          >
                            Xoá và trích xuất lại
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="h-6 text-xs px-2"
                            onClick={() => setConfirmReExtract(false)}
                          >
                            Giữ nội dung hiện tại
                          </Button>
                        </div>
                      </div>
                    )}

                    {hasTranscriptContent && extractState.phase !== "error" && !isExtracting && !isSyncing && (
                      <WorkflowStatusSummary
                        tone="success"
                        title="Đã có transcript"
                        description={hasSegments
                          ? `Transcript hiện có ${segments.length} đoạn. Bạn có thể chỉnh sửa trước khi phân đoạn.`
                          : "Transcript đã có sẵn cho bài học này. Nếu cần chỉnh từng đoạn theo thời gian, hãy trích xuất lại từ video."}
                      />
                    )}
                    {isSyncing && (
                      <WorkflowStatusSummary
                        tone="warning"
                        title="Đang kiểm tra tiến trình trước"
                        description="Tiến trình trước có vẻ bị gián đoạn. Nếu không tự hoàn tất, hãy thử trích xuất lại."
                      />
                    )}
                    {extractState.phase !== "idle" && extractState.phase !== "syncing" && (
                      <div data-testid="extract-progress">
                        <ProgressStrip steps={EXTRACT_STEPS} runState={extractState} stepTimings={extractTimings} now={now} />
                      </div>
                    )}
                    {extractState.phase === "error" && (
                      <WorkflowStatusSummary
                        tone="error"
                        title="Không thể phiên âm video"
                        description="Hãy thử lại hoặc kiểm tra video có âm thanh rõ ràng."
                        technicalDetail={extractState.message}
                        testId="extract-error"
                      />
                    )}
                  </div>
                </WorkflowTaskSection>
              ) : (
                <WorkflowReadyState
                  icon={<FileTextIcon className="size-4" />}
                  title="Video sẵn sàng phiên âm"
                  description="Video đã được tải lên và có thể được xử lý để tạo transcript cho các bước phân đoạn và bài tập."
                />
              )}

              {hasSegments && (
                <WorkflowTaskSection
                  title="Chỉnh sửa transcript" status={step3Status}
                  optional collapsible defaultOpen={hasSegments}
                >
                  <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                    {segments.map((seg, i) => (
                      <SegmentRow
                        key={i}
                        segment={seg}
                        index={i}
                        lessonId={lessonId}
                        disabled={isBusy}
                        aiClient={aiClient}
                        onUpdated={(idx, text) =>
                          setSegments(prev => prev.map((s, j) => j === idx ? { ...s, text } : s))
                        }
                        onSaved={() => {
                          setChunkState({ phase: "idle" });
                          setChunkTimings({});
                          setGenState({ phase: "idle" });
                          setGenWarnings([]);
                          // Bug 3 fix: refresh the RSC so VideoPlayer receives updated segments.
                          router.refresh();
                        }}
                      />
                    ))}
                  </div>
                </WorkflowTaskSection>
              )}
            </>
          )}
        </div>
      )}

      {activeStep === "chunks" && (
        <div className="flex flex-col gap-3 animate-in fade-in duration-200">
          {!hasTranscriptContent ? (
            <div className="flex flex-col items-center justify-center p-10 text-center border border-dashed border-border/80 rounded-2xl bg-muted/5 shadow-inner">
              <div className="rounded-full bg-muted/20 p-4 border border-border/40 mb-3.5">
                <LockIcon className="size-6 text-muted-foreground animate-pulse" />
              </div>
              <h3 className="text-sm font-semibold text-foreground/90">Tính năng phân đoạn chưa sẵn sàng</h3>
              <p className="text-xs text-muted-foreground max-w-sm mt-1.5 leading-relaxed">
                Vui lòng hoàn thành Bước 2: Phiên âm trước để tạo văn bản bài giảng. Sau khi có transcript, AI sẽ tự động phân tích cấu trúc bài giảng để chia thành các phân đoạn ngữ cảnh rõ ràng.
              </p>
            </div>
          ) : (
            <>
              {shouldShowChunkTask ? (
                <WorkflowTaskSection
                  title="Tác vụ phân đoạn"
                  status={step4Status}
                  optional
                  collapsible
                  defaultOpen={!hasChunks || chunkState.phase === "error"}
                >
                  <div className="flex flex-col gap-2">
                    {hasChunks && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={handleChunk}
                        className="gap-2 w-fit"
                      >
                        {isChunking
                          ? <Loader2Icon className="size-4 animate-spin" />
                          : <RefreshCwIcon className="size-4" />}
                        {isChunking ? "Đang phân đoạn..." : "Phân đoạn lại"}
                      </Button>
                    )}
                    {hasChunks && chunkState.phase !== "error" && !isChunking && !isChunkSyncing && (
                      <WorkflowStatusSummary
                        tone="success"
                        title="Đã phân đoạn bài học"
                        description={`Bài học hiện có ${chunks.length} phân đoạn. Bạn có thể chỉnh sửa trước khi tạo bài tập.`}
                      />
                    )}
                    {isChunkSyncing && (
                      <WorkflowStatusSummary
                        tone="warning"
                        title="Đang kiểm tra tiến trình phân đoạn"
                        description="Phân đoạn trước có vẻ bị gián đoạn. Nếu không tự hoàn tất, hãy thử phân đoạn lại."
                      />
                    )}
                    {chunkState.phase !== "idle" && chunkState.phase !== "syncing" && (
                      <div data-testid="chunk-progress">
                        <ProgressStrip steps={CHUNK_STEPS} runState={chunkState} stepTimings={chunkTimings} now={now} />
                      </div>
                    )}
                    {chunkState.phase === "error" && (
                      <WorkflowStatusSummary
                        tone="error"
                        title="Không thể phân đoạn bài học"
                        description="Transcript đã có, nhưng bước chia nội dung gặp lỗi. Hãy thử lại."
                        technicalDetail={chunkState.message}
                        testId="chunk-error"
                      />
                    )}
                  </div>
                </WorkflowTaskSection>
              ) : (
                <WorkflowReadyState
                  icon={<ListTreeIcon className="size-4" />}
                  title="Transcript sẵn sàng phân đoạn"
                  description="Transcript đã có sẵn để chia thành các phân đoạn học tập có ngữ cảnh rõ ràng."
                />
              )}

              {hasChunks && (
                <WorkflowTaskSection
                  title="Chỉnh sửa phân đoạn" status={step5Status}
                  optional collapsible defaultOpen={hasChunks}
                >
                  <div className="flex flex-col gap-1.5">
                    {isReloadingChunks ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2Icon className="size-3 animate-spin" /> Đang tải...
                      </div>
                    ) : (
                      chunks.map((chunk, i) => (
                        <ChunkEditor
                          key={chunk.id}
                          chunk={chunk}
                          chunkSegments={getChunkSegments(chunk, segments)}
                          prevChunkId={i > 0 ? chunks[i - 1].id : null}
                          nextChunkId={i < chunks.length - 1 ? chunks[i + 1].id : null}
                          onMergeWithPrev={handleMergeWithPrev}
                          onMergeWithNext={handleMergeWithNext}
                          onDelete={handleDeleteChunk}
                          onSplit={handleSplitChunk}
                          onMoveSegment={handleMoveSegment}
                          isMerging={mutatingChunkId === chunk.id && mutatingOp === "merge"}
                          isDeleting={mutatingChunkId === chunk.id && mutatingOp === "delete"}
                          isSplitting={mutatingChunkId === chunk.id && mutatingOp === "split"}
                          isMoving={mutatingChunkId === chunk.id && mutatingOp === "move"}
                          disabled={isBusy}
                        />
                      ))
                    )}
                    {mutatingError && (
                      <p className="text-xs text-destructive mt-1">{mutatingError}</p>
                    )}
                  </div>
                </WorkflowTaskSection>
              )}
            </>
          )}
        </div>
      )}

      {activeStep === "exercises" && (
        <TabExercises
          lessonId={lessonId}
          chunks={chunks}
          segments={segments}
          initialInteractions={interactions}
          defaultInteractionConfig={initialDefaultInteractionConfig}
          token={token}
          disabled={isBusy}
          genState={genState}
          genWarnings={genWarnings}
          questionsGenerated={questionsGenerated}
          feedbackMode={feedbackMode}
          savingFeedback={savingFeedback}
          openLessonGenerateRequest={exerciseOpenRequest}
          onFeedbackModeChange={handleFeedbackModeChange}
          onGenerateLesson={(force, difficulty, focusPrompt) => handleGenerate(force, undefined, difficulty, focusPrompt)}
          onGenerateChunk={(chunkId, force) => handleGenerate(force, chunkId)}
          onInteractionsChange={setInteractions}
        />
      )}
      </WorkflowStepPanel>
    </div>
  );
}
