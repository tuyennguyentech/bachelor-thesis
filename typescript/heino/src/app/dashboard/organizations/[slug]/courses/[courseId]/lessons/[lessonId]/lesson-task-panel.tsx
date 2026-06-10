"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon, CheckIcon, Loader2Icon, RefreshCwIcon, StopCircleIcon, XIcon } from "lucide-react";
import { type LessonTask, LessonTaskKind, LessonTaskStatus } from "buf/gen/richter/v1/ai_pb";
import { isLessonTaskActive } from "./use-lesson-tasks";
import { analysisConfig } from "@/lib/client-config";

/**
 * Steps whose corresponding task is rendered by the bottom step card
 * (ExtractProgressCard / ChunkProgressCard / etc.). Active tasks for
 * the current step are hidden from this top panel — the bottom card is
 * the single source of truth for live progress, including cancel and
 * sub-step detail. "upload" and "preview" have no matching bottom card
 * and are treated as null.
 */
export type PanelStep = "transcript" | "chunks" | "exercises" | null;

const FAILED_DISMISS_MS = 30_000;
const SUCCEEDED_DISMISS_MS = 5_000;

function taskTitle(task: LessonTask) {
  switch (task.kind) {
    case LessonTaskKind.EXTRACT_TRANSCRIPT:
      return "Phiên âm video";
    case LessonTaskKind.CHUNK_TRANSCRIPT:
      return "Phân đoạn bài học";
    case LessonTaskKind.GENERATE_INTERACTIONS:
      return task.chunkId ? "Tạo bài tập cho đoạn" : "Tạo bài tập";
    default:
      return "Tác vụ bài học";
  }
}

// Map a task kind to the workflow step whose bottom card is the
// canonical progress display for that task. The top `LessonTaskPanel`
// hides tasks whose kind matches the step the user is currently
// viewing, so the same task is never rendered twice.
function taskKindToStep(kind: LessonTaskKind): PanelStep {
  switch (kind) {
    case LessonTaskKind.EXTRACT_TRANSCRIPT:
      return "transcript";
    case LessonTaskKind.CHUNK_TRANSCRIPT:
      return "chunks";
    case LessonTaskKind.GENERATE_INTERACTIONS:
      return "exercises";
    default:
      return null;
  }
}

function statusTone(task: LessonTask, now: number) {
  if (isTaskStale(task, now)) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  switch (task.status) {
    case LessonTaskStatus.SUCCEEDED:
      return "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300";
    case LessonTaskStatus.FAILED:
    case LessonTaskStatus.CANCELED:
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  }
}

function TaskStatusIcon({ task, now }: { task: LessonTask; now: number }) {
  if (isTaskStale(task, now)) return <AlertCircleIcon className="size-3.5" />;
  if (isLessonTaskActive(task)) return <Loader2Icon className="size-3.5 animate-spin" />;
  if (task.status === LessonTaskStatus.SUCCEEDED) return <CheckIcon className="size-3.5" />;
  return <XIcon className="size-3.5" />;
}

// timestampToMs converts a google.protobuf.Timestamp shape (seconds +
// nanos BigInt-style numbers) to a JS milliseconds number, or null if
// the field is missing.
function timestampToMs(ts: { seconds?: number | bigint | null; nanos?: number | null } | null | undefined): number | null {
  if (!ts) return null;
  const secs = ts.seconds == null ? 0 : Number(ts.seconds);
  const nanos = ts.nanos == null ? 0 : Number(ts.nanos);
  if (!Number.isFinite(secs) || !Number.isFinite(nanos)) return null;
  return secs * 1000 + Math.floor(nanos / 1_000_000);
}

function isTaskStale(task: LessonTask, now: number): boolean {
  if (!isLessonTaskActive(task)) return false;
  if (analysisConfig.heartbeatTimeoutMs <= 0 && analysisConfig.staleThresholdMs <= 0) return false;
  
  const taskAny = task as { lastHeartbeat?: { seconds?: number | bigint | null; nanos?: number | null } };
  const lastHb = timestampToMs(taskAny.lastHeartbeat) ?? timestampToMs(task.updatedAt) ?? timestampToMs(task.createdAt);
  const created = timestampToMs(task.createdAt);
  
  if (task.status === LessonTaskStatus.RUNNING && analysisConfig.heartbeatTimeoutMs > 0 && lastHb != null) {
    if (now - lastHb > analysisConfig.heartbeatTimeoutMs) return true;
  }
  if (task.status === LessonTaskStatus.QUEUED && analysisConfig.staleThresholdMs > 0 && created != null) {
    if (now - created > analysisConfig.staleThresholdMs) return true;
  }
  return false;
}

function shouldKeepTask(task: LessonTask, dismissedIds: Set<string>, now: number): boolean {
  if (dismissedIds.has(task.id)) return false;
  if (isLessonTaskActive(task)) return true;
  const finished = timestampToMs(task.finishedAt);
  if (task.status === LessonTaskStatus.FAILED || task.status === LessonTaskStatus.CANCELED) {
    if (finished == null) return true;
    return now - finished < FAILED_DISMISS_MS;
  }
  if (task.status === LessonTaskStatus.SUCCEEDED) {
    if (finished == null) return false;
    return now - finished < SUCCEEDED_DISMISS_MS;
  }
  return false;
}

export function LessonTaskPanel({
  tasks,
  activeStep,
  onRefresh,
  onCancel,
}: {
  tasks: LessonTask[];
  /**
   * Current workflow step the user is viewing. Tasks whose canonical
   * step matches are filtered out so the same progress is not
   * rendered twice (top panel + bottom step card).
   */
  activeStep: PanelStep;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
}) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(() => Date.now());

  // Tick once per second while there is a still-visible terminal task
  // so the auto-dismiss thresholds actually fire even without a parent
  // re-render. Inactive tasks are cheap to filter; we only tick when
  // needed.
  useEffect(() => {
    const hasTerminalWithDeadline = tasks.some((t) => {
      if (isLessonTaskActive(t)) return false;
      const finished = timestampToMs(t.finishedAt);
      if (finished == null) return false;
      if (t.status === LessonTaskStatus.FAILED || t.status === LessonTaskStatus.CANCELED) {
        return Date.now() - finished < FAILED_DISMISS_MS + 1000;
      }
      if (t.status === LessonTaskStatus.SUCCEEDED) {
        return Date.now() - finished < SUCCEEDED_DISMISS_MS + 1000;
      }
      return false;
    });
    if (!hasTerminalWithDeadline) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [tasks]);

  const visibleTasks = tasks.filter(
    (task) => shouldKeepTask(task, dismissedIds, tick),
  );
  if (visibleTasks.length === 0) return null;

  // Hide active tasks that belong to the user's current step — the
  // bottom ExtractProgressCard / ChunkProgressCard renders full live
  // progress for that step, so showing the same task here would be
  // pure duplication. Everything else (other-step running tasks and
  // recent terminal results for any step) is still useful as a
  // background/recency signal.
  const displayTasks = visibleTasks.filter(
    (task) => taskKindToStep(task.kind) !== activeStep || !isLessonTaskActive(task),
  );
  if (displayTasks.length === 0) return null;

  return (
    <section className="rounded-md border border-border/70 bg-card/60 p-3" data-testid="lesson-task-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Tác vụ khác</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Có thể rời trang hoặc tải lại, tiến trình vẫn được lưu theo tác vụ.
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={onRefresh} title="Làm mới tác vụ">
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>
      <div className="mt-3 grid gap-2">
        {displayTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onCancel={onCancel}
            onDismiss={() => {
              setDismissedIds((prev) => {
                if (prev.has(task.id)) return prev;
                const next = new Set(prev);
                next.add(task.id);
                return next;
              });
            }}
          />
        ))}
      </div>
    </section>
  );
}

function TaskRow({
  task,
  onCancel,
  onDismiss,
}: {
  task: LessonTask;
  onCancel: (taskId: string) => void;
  onDismiss: () => void;
}) {
  const active = isLessonTaskActive(task);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stale = isTaskStale(task, now);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  // Compute "elapsed" using the task's startedAt timestamp if present
  // (server-authoritative), else fall back to the local observer's
  // Date.now() baseline. Server time keeps the displayed value
  // consistent across page reloads / tab re-opens.
  const startedAtMs = timestampToMs(task.startedAt);
  const elapsedSec = active
    ? Math.max(0, Math.floor((now - (startedAtMs ?? now)) / 1000))
    : null;
  const elapsedLabel = elapsedSec == null
    ? null
    : elapsedSec < 60
      ? `${elapsedSec}s`
      : `${Math.floor(elapsedSec / 60)}m${(elapsedSec % 60).toString().padStart(2, "0")}s`;

  const handleCancel = () => {
    if (cancelling) return;
    setCancelling(true);
    onCancel(task.id);
  };

  return (
    <div className={`rounded-md border px-3 py-2 ${statusTone(task, now)}`} data-testid={`lesson-task-row-${task.id}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background/70">
          <TaskStatusIcon task={task} now={now} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{taskTitle(task)}</p>
            <div className="flex shrink-0 items-center gap-2">
              {elapsedLabel && (
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  data-testid={`lesson-task-elapsed-${task.id}`}
                >
                  {elapsedLabel}
                </span>
              )}
              {active && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={handleCancel}
                  disabled={cancelling}
                  title="Hủy tác vụ"
                  data-testid={`lesson-task-cancel-${task.id}`}
                >
                  {cancelling
                    ? <Loader2Icon className="size-3.5 animate-spin" />
                    : <StopCircleIcon className="size-3.5" />}
                </Button>
              )}
              {!active && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={onDismiss}
                  title="Ẩn"
                  data-testid={`lesson-task-dismiss-${task.id}`}
                >
                  <XIcon className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-0.5 truncate text-xs opacity-90">
            {stale
              ? "Tác vụ có vẻ bị treo — worker không phản hồi. Hệ thống sẽ tự động khôi phục."
              : (task.message || task.errorMsg || (active ? "Đang xử lý..." : ""))}
          </p>
          {active && !stale && (
            <div className="mt-2 flex items-center gap-2 text-xs opacity-80">
              <Loader2Icon className="size-3 animate-spin" />
              <span>Đang xử lý — không tải lại trang cho đến khi hoàn tất.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

