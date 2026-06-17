"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  LockIcon,
  RefreshCwIcon,
  StopCircleIcon,
  XIcon,
} from "lucide-react";
import {
  AnalysisProgressStep,
  AnalysisStatus,
  type TranscriptChunk,
  type TranscriptSegment,
} from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";

export const EXTRACT_STEPS = [
  { step: AnalysisProgressStep.DOWNLOADING, label: "Tải video từ storage" },
  { step: AnalysisProgressStep.UPLOADING, label: "Trích xuất âm thanh" },
  { step: AnalysisProgressStep.ANALYZING, label: "Đang phiên âm" },
  { step: AnalysisProgressStep.SAVING, label: "Lưu kết quả" },
] as const;

export const CHUNK_STEPS = [
  { step: AnalysisProgressStep.ANALYZING, label: "Đang phân đoạn nội dung" },
  { step: AnalysisProgressStep.SAVING, label: "Lưu các đoạn" },
] as const;

type StepState = "pending" | "active" | "done" | "error";

/**
 * Per-step pipeline state machine. The hero card and progress strip
 * are rendered for every non-idle phase so the user always sees a
 * single, live source of truth for the current step's task.
 *
 *   idle      — no task has ever run (or the result was cleared)
 *   starting  — user clicked start; BE has not yet responded with a
 *               task. Brief intermediate state, no progress to show.
 *   syncing   — BE has a task in QUEUED or RUNNING for this step, but
 *               FE has no local data yet. Polling for completion.
 *   running   — BE confirmed RUNNING with at least one progress tick.
 *   stale     — BE task is QUEUED or RUNNING but hasn't updated in
 *               longer than the heartbeat window. Recovery UI shown.
 *   done      — task completed successfully.
 *   error     — task failed or was cancelled. Retry UI shown.
 */
export type StreamRunState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "syncing" }
  | { phase: "running"; currentStep: AnalysisProgressStep | null }
  | { phase: "stale"; currentStep: AnalysisProgressStep | null }
  | { phase: "done" }
  | { phase: "error"; failedAt: AnalysisProgressStep | null; message: string };

export type WorkflowStepKey = "upload" | "transcript" | "chunks" | "exercises" | "preview";
export type WorkflowContentStepKey = Extract<WorkflowStepKey, "upload" | "transcript" | "chunks" | "exercises">;
export type WorkflowStatus = "locked" | "ready" | "active" | "running" | "done" | "error";
export type PipelineStepStatus = "locked" | "available" | "active" | "done" | "error";

function getStepState(step: AnalysisProgressStep, run: StreamRunState): StepState {
  if (run.phase === "idle" || run.phase === "syncing" || run.phase === "starting" || run.phase === "stale") return "pending";
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

function formatStepDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function formatHeroElapsed(sec: number): string {
  if (sec < 0) sec = 0;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
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

export function ProgressStrip({
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

/**
 * Hero card for a step's task — the *single* place where live progress,
 * error state, and recovery actions are surfaced to the user. The top
 * `LessonTaskPanel` deliberately hides the active step's running task
 * to avoid duplicating it up there; the `WorkflowNextAction` panel is
 * also hidden when this hero is showing. Together those three rules
 * guarantee that the user always sees exactly one source of truth for
 * the current step.
 *
 * The `state` prop drives the visual tone, animation, and the button
 * set rendered. Per-step cards (Extract, Chunk, Generate) pick the
 * state by reading the corresponding `StreamRunState` / `GenRunState`
 * phase; they then pass the right callbacks and copy down.
 */
export type HeroState =
  | "starting"
  | "syncing"
  | "running"
  | "stale"
  | "error"
  | "done";

const HERO_TONE: Record<HeroState, { border: string; bg: string; accent: string; icon: string; spin: boolean }> = {
  starting: { border: "border-blue-500/30", bg: "bg-gradient-to-br from-blue-500/5 via-card to-indigo-500/5", accent: "from-blue-500/60 via-indigo-400/60 to-blue-500/60", icon: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/40", spin: false },
  syncing:  { border: "border-blue-500/30", bg: "bg-gradient-to-br from-blue-500/5 via-card to-indigo-500/5", accent: "from-blue-500/40 via-indigo-400/40 to-blue-500/40", icon: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/40", spin: true },
  running:  { border: "border-blue-500/40", bg: "bg-gradient-to-br from-blue-500/8 via-card to-indigo-500/8", accent: "from-blue-500 via-indigo-400 to-blue-500", icon: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/50", spin: true },
  stale:    { border: "border-amber-500/50", bg: "bg-gradient-to-br from-amber-500/8 via-card to-orange-500/5", accent: "from-amber-500/70 via-orange-400/70 to-amber-500/70", icon: "text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/50", spin: false },
  error:    { border: "border-destructive/50", bg: "bg-gradient-to-br from-destructive/8 via-card to-destructive/5", accent: "from-destructive/70 via-destructive/40 to-destructive/70", icon: "text-destructive bg-destructive/10 border-destructive/50", spin: false },
  done:     { border: "border-green-500/40", bg: "bg-gradient-to-br from-green-500/8 via-card to-emerald-500/5", accent: "from-green-500 via-emerald-400 to-green-500", icon: "text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/50", spin: false },
};

export function WorkflowProgressHero({
  state,
  title,
  subtitle,
  elapsedSec = 0,
  showElapsed = true,
  cancelling = false,
  retrying = false,
  onCancel,
  onRetry,
  testId,
  errorTestId,
  children,
}: {
  state: HeroState;
  /** Big bold title. Driven by state by the caller. */
  title: string;
  /** Secondary line under the title. e.g. the current sub-step label, or error message. */
  subtitle?: string;
  /** Live elapsed seconds. Ticked by parent. */
  elapsedSec?: number;
  /** Whether to render the elapsed counter. Off for `starting` and `done`. */
  showElapsed?: boolean;
  /** Disables the cancel button and swaps its icon for a spinner. */
  cancelling?: boolean;
  /** Disables the retry button and swaps its icon for a spinner. */
  retrying?: boolean;
  /** Cancel callback. Shown for active states. */
  onCancel?: () => void;
  /** Retry / restart callback. Shown for `stale` (primary) and `error` (primary). */
  onRetry?: () => void;
  testId?: string;
  /** Optional alternate testId for the error variant — keeps existing
   *  selectors like `gen-error` working when the hero is used for
   *  generation. Falls back to `testId` when not provided. */
  errorTestId?: string;
  /** Sub-step strip, rendered in the card body. */
  children?: React.ReactNode;
}) {
  const tone = HERO_TONE[state];
  const iconEl = tone.spin
    ? <Loader2Icon className="size-4 animate-spin" />
    : state === "stale" ? <AlertCircleIcon className="size-4" />
    : state === "error" ? <XIcon className="size-4" />
    : state === "done"  ? <CheckIcon className="size-4" />
    : <Loader2Icon className="size-4" />;

  return (
    <div
      className={`relative overflow-hidden rounded-lg border-2 shadow-sm ${tone.border} ${tone.bg}`}
      data-testid={state === "error" && errorTestId ? errorTestId : testId}
    >
      <div
        aria-hidden
        className={`h-1 w-full bg-gradient-to-r bg-[length:200%_100%] ${tone.accent} ${tone.spin ? "animate-pulse" : ""}`}
      />
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-full border-2 ${tone.icon}`}>
          {iconEl}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          {(subtitle || showElapsed) && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              {subtitle && <span className="truncate">{subtitle}</span>}
              {subtitle && showElapsed && <span className="text-muted-foreground/50" aria-hidden>·</span>}
              {showElapsed && (
                <span
                  className="tabular-nums shrink-0"
                  data-testid={testId ? `${testId}-elapsed` : undefined}
                >
                  {formatHeroElapsed(elapsedSec)}
                </span>
              )}
            </p>
          )}
        </div>
        {state === "running" && onCancel && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={cancelling}
            title="Hủy tác vụ"
            data-testid={testId ? `${testId}-cancel` : undefined}
            className="shrink-0"
          >
            {cancelling
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <StopCircleIcon className="size-3.5" />}
            <span className="ml-1.5">Hủy</span>
          </Button>
        )}
        {state === "syncing" && onCancel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={cancelling}
            title="Hủy tác vụ"
            data-testid={testId ? `${testId}-cancel` : undefined}
            className="shrink-0"
          >
            {cancelling
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <XIcon className="size-3.5" />}
            <span className="ml-1.5">Hủy</span>
          </Button>
        )}
        {state === "stale" && (
          <>
            {onRetry && (
              <Button
                variant="default"
                size="sm"
                onClick={onRetry}
                disabled={retrying}
                title="Hủy tác vụ hiện tại và bắt đầu lại"
                data-testid={testId ? `${testId}-retry` : undefined}
                className="shrink-0"
              >
                {retrying
                  ? <Loader2Icon className="size-3.5 animate-spin" />
                  : <RefreshCwIcon className="size-3.5" />}
                <span className="ml-1.5">Hủy & thử lại</span>
              </Button>
            )}
            {onCancel && (
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={cancelling}
                title="Hủy tác vụ"
                data-testid={testId ? `${testId}-cancel` : undefined}
                className="shrink-0"
              >
                {cancelling
                  ? <Loader2Icon className="size-3.5 animate-spin" />
                  : <StopCircleIcon className="size-3.5" />}
                <span className="ml-1.5">Hủy</span>
              </Button>
            )}
          </>
        )}
        {state === "error" && onRetry && (
          <Button
            variant="default"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            title="Bắt đầu lại tác vụ"
            data-testid={testId ? `${testId}-retry` : undefined}
            className="shrink-0"
          >
            {retrying
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <RefreshCwIcon className="size-3.5" />}
            <span className="ml-1.5">Thử lại</span>
          </Button>
        )}
      </div>
      {children && (
        <div className="border-t border-current/10 bg-background/40 px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

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

export function VideoProcessingStepper({
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

export function WorkflowActionPanel({
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


export function WorkflowReadyState({
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

export function WorkflowStepPanel({
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

export function WorkflowTaskSection({
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

export function getInitialWorkflowStep(
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
