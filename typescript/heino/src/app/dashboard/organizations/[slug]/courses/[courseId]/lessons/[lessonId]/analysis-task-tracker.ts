"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { analysisConfig } from "@/lib/client-config";
import {
  AnalysisProgressStep,
  AnalysisStatus,
  type LessonTask,
  LessonTaskKind,
  LessonTaskStatus,
  type TranscriptChunk,
  type TranscriptSegment,
} from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { ConnectError } from "@connectrpc/connect";
import type { GenRunState } from "./use-lesson-analysis-state";
import type { StreamRunState } from "./analysis-workflow-ui";
import type { StepperAction } from "./analysis-stepper";

export type AnalysisAIClient = {
  getLessonAnalysis: (req: { lessonId: string }) => Promise<{ analysis?: { status: AnalysisStatus; transcriptSegments: TranscriptSegment[]; interactions?: LessonInteraction[] } | null; chunks?: TranscriptChunk[] }>;
  listLessonTranscriptChunks: (req: { lessonId: string; limit: number; offset: number }) => Promise<{ chunks: TranscriptChunk[] }>;
};

function analysisStepFromTask(task: LessonTask): AnalysisProgressStep | null {
  const step = task.progressStep;
  if (step.includes("DOWNLOADING")) return AnalysisProgressStep.DOWNLOADING;
  if (step.includes("UPLOADING")) return AnalysisProgressStep.UPLOADING;
  if (step.includes("ANALYZING")) return AnalysisProgressStep.ANALYZING;
  if (step.includes("SAVING")) return AnalysisProgressStep.SAVING;
  return null;
}

export interface UseAnalysisTaskTrackerInput {
  lessonId: string;
  lessonTasks: LessonTask[];
  aiClient: AnalysisAIClient;
  startedTaskIdsRef: React.MutableRefObject<Set<string>>;
  completedTaskIdsRef: React.MutableRefObject<Set<string>>;
  taskStatusByIdRef: React.MutableRefObject<Map<string, LessonTaskStatus>>;
  setSegments: React.Dispatch<React.SetStateAction<TranscriptSegment[]>>;
  setChunks: React.Dispatch<React.SetStateAction<TranscriptChunk[]>>;
  setInteractionsState: React.Dispatch<React.SetStateAction<LessonInteraction[]>>;
  setExtractState: React.Dispatch<React.SetStateAction<StreamRunState>>;
  setChunkState: React.Dispatch<React.SetStateAction<StreamRunState>>;
  setGenState: React.Dispatch<React.SetStateAction<GenRunState>>;
  setExtractTimings: React.Dispatch<React.SetStateAction<Partial<Record<number, { start: number; end?: number }>>>>;
  setChunkTimings: React.Dispatch<React.SetStateAction<Partial<Record<number, { start: number; end?: number }>>>>;
  reloadChunks: () => Promise<void>;
  dispatchStep: (action: StepperAction) => void;
}

/**
 * Watches the polled lesson task list and propagates transitions into the
 * local workflow state machine. Owns the "task A finished, refresh + advance
 * step" cascade. Reads task state via `taskStatusByIdRef` to detect edge
 * transitions (active → terminal) and dedupes terminal processing via
 * `completedTaskIdsRef`.
 */
export function useAnalysisTaskTracker(input: UseAnalysisTaskTrackerInput): void {
  const router = useRouter();
  const {
    lessonId,
    lessonTasks,
    aiClient,
    startedTaskIdsRef,
    completedTaskIdsRef,
    taskStatusByIdRef,
    setSegments,
    setChunks,
    setInteractionsState,
    setExtractState,
    setChunkState,
    setGenState,
    setExtractTimings,
    setChunkTimings,
    reloadChunks,
    dispatchStep,
  } = input;

  useEffect(() => {
    for (const task of lessonTasks) {
      const previousStatus = taskStatusByIdRef.current.get(task.id);
      taskStatusByIdRef.current.set(task.id, task.status);

      const isActiveTask = task.status === LessonTaskStatus.QUEUED || task.status === LessonTaskStatus.RUNNING;
      const isTerminalTask =
        task.status === LessonTaskStatus.SUCCEEDED ||
        task.status === LessonTaskStatus.FAILED ||
        task.status === LessonTaskStatus.CANCELED;

      if (isActiveTask) {
        const currentStep = analysisStepFromTask(task);
        if (task.kind === LessonTaskKind.EXTRACT_TRANSCRIPT) {
          setExtractState({ phase: "running", currentStep });
          // Track per-step timings so the ProgressStrip can show
          // "Step 3: 45s" instead of nothing during long steps. We
          // start the active step on first observation, mark the
          // previous step's end on transition, and let the ticker in
          // use-lesson-analysis-state render the live elapsed.
          if (currentStep != null) {
            const now = Date.now();
            setExtractTimings((prev) => updateStepTimings(prev, currentStep, now));
          }
        } else if (task.kind === LessonTaskKind.CHUNK_TRANSCRIPT) {
          setChunkState({ phase: "running", currentStep });
          if (currentStep != null) {
            const now = Date.now();
            setChunkTimings((prev) => updateStepTimings(prev, currentStep, now));
          }
        } else if (task.kind === LessonTaskKind.GENERATE_INTERACTIONS) {
          setGenState({
            phase: "running",
            message: task.message || "Đang tạo bài tập...",
            chunkIndex: Math.max(0, task.progressCurrent - 1),
            totalChunks: task.progressTotal,
          });
        }
        continue;
      }

      const transitionedFromActive =
        previousStatus === LessonTaskStatus.QUEUED ||
        previousStatus === LessonTaskStatus.RUNNING ||
        startedTaskIdsRef.current.has(task.id);
      if (!isTerminalTask || !transitionedFromActive || completedTaskIdsRef.current.has(task.id)) continue;
      completedTaskIdsRef.current.add(task.id);
      startedTaskIdsRef.current.delete(task.id);

      // Mark all currently-tracked steps as ended so the ProgressStrip
      // shows the final duration for the step we ended on.
      if (task.kind === LessonTaskKind.EXTRACT_TRANSCRIPT) {
        const endedAt = Date.now();
        setExtractTimings((prev) => closeStepTimings(prev, endedAt));
      } else if (task.kind === LessonTaskKind.CHUNK_TRANSCRIPT) {
        const endedAt = Date.now();
        setChunkTimings((prev) => closeStepTimings(prev, endedAt));
      }

      if (task.status === LessonTaskStatus.SUCCEEDED) {
        if (task.kind === LessonTaskKind.EXTRACT_TRANSCRIPT) {
          setExtractState({ phase: "done" });
          void (async () => {
            try {
              const r = await aiClient.getLessonAnalysis({ lessonId });
              const a = r?.analysis ?? null;
              const fresh = r?.chunks ?? [];
              if (a) {
                setSegments(a.transcriptSegments);
                setChunks(fresh);
              }
              dispatchStep({ type: "ADVANCE_AFTER_EXTRACT", hasChunks: fresh.length > 0 });
              router.refresh();
            } catch (err) {
              if (!(err instanceof ConnectError)) {
                // network error — keep current state
              }
            }
          })();
        } else if (task.kind === LessonTaskKind.CHUNK_TRANSCRIPT) {
          setChunkState({ phase: "done" });
          void (async () => {
            await reloadChunks();
            dispatchStep({ type: "ADVANCE_AFTER_CHUNK" });
            router.refresh();
          })();
        } else if (task.kind === LessonTaskKind.GENERATE_INTERACTIONS) {
          void (async () => {
            const r = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
            // Set the fresh data FIRST, then mark the run as done. The previous
            // ordering (done → fetch → set) left a window where the UI showed
            // "Tạo bài tập thành công!" against the previous interactions list,
            // which made the "X/Y phân đoạn" counter look incomplete until the
            // user manually refreshed the page. Loading the new data before
            // flipping the phase keeps the count and the success banner in sync.
            if (r?.analysis?.interactions) {
              setInteractionsState(r.analysis.interactions);
            }
            setGenState({ phase: "done" });
            router.refresh();
          })();
        }
      } else if (task.status === LessonTaskStatus.FAILED || task.status === LessonTaskStatus.CANCELED) {
        const msg = task.errorMsg || task.message || "Tác vụ thất bại.";
        if (task.kind === LessonTaskKind.EXTRACT_TRANSCRIPT) {
          setExtractState({ phase: "error", failedAt: null, message: msg });
        } else if (task.kind === LessonTaskKind.CHUNK_TRANSCRIPT) {
          setChunkState({ phase: "error", failedAt: null, message: msg });
        } else if (task.kind === LessonTaskKind.GENERATE_INTERACTIONS) {
          setGenState({ phase: "error", message: msg });
        }
      }
    }
  }, [
    aiClient,
    dispatchStep,
    lessonId,
    lessonTasks,
    reloadChunks,
    router,
    setChunks,
    setExtractState,
    setChunkState,
    setGenState,
    setInteractionsState,
    setSegments,
    setExtractTimings,
    setChunkTimings,
    startedTaskIdsRef,
    completedTaskIdsRef,
    taskStatusByIdRef,
  ]);

  // Stale detection
  useEffect(() => {
    if (analysisConfig.staleThresholdMs <= 0 && analysisConfig.heartbeatTimeoutMs <= 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const task of lessonTasks) {
        if (task.status !== LessonTaskStatus.QUEUED && task.status !== LessonTaskStatus.RUNNING) continue;
        
        let isStale = false;
        // Access protobuf Timestamp fields safely. They may be undefined or have
        // a toDate() method returning Date. We narrow via optional chaining.
        const getMs = (ts?: { toDate?: () => Date } | undefined): number =>
          ts?.toDate?.()?.getTime() ?? now;
        const lastHb = getMs((task as { lastHeartbeat?: { toDate?: () => Date } }).lastHeartbeat) ||
          getMs((task as { updatedAt?: { toDate?: () => Date } }).updatedAt) ||
          getMs((task as { createdAt?: { toDate?: () => Date } }).createdAt);
        const created = getMs((task as { createdAt?: { toDate?: () => Date } }).createdAt);

        if (analysisConfig.heartbeatTimeoutMs > 0 && task.status === LessonTaskStatus.RUNNING) {
          if (now - lastHb > analysisConfig.heartbeatTimeoutMs) isStale = true;
        }
        if (analysisConfig.staleThresholdMs > 0 && task.status === LessonTaskStatus.QUEUED) {
          if (now - created > analysisConfig.staleThresholdMs) isStale = true;
        }

        if (isStale) {
          const currentStep = analysisStepFromTask(task);
          if (task.kind === LessonTaskKind.EXTRACT_TRANSCRIPT) {
            setExtractState((prev) => prev.phase === "running" || prev.phase === "syncing" ? { phase: "stale", currentStep } : prev);
          } else if (task.kind === LessonTaskKind.CHUNK_TRANSCRIPT) {
            setChunkState((prev) => prev.phase === "running" || prev.phase === "syncing" ? { phase: "stale", currentStep } : prev);
          } else if (task.kind === LessonTaskKind.GENERATE_INTERACTIONS) {
            setGenState((prev) => prev.phase === "running" ? { phase: "stale", message: "Tiến trình bị treo.", chunkIndex: prev.chunkIndex, totalChunks: prev.totalChunks } : prev);
          }
        }
      }
    }, analysisConfig.heartbeatPollMs || 5000);
    return () => clearInterval(interval);
  }, [lessonTasks, setExtractState, setChunkState, setGenState]);
}

// updateStepTimings records `start` for `currentStep` and closes the
// previously-tracked step (if any) with `end = now`. Steps already
// finished are never re-opened. Returns a new object to keep React
// state pure.
function updateStepTimings(
  prev: Partial<Record<number, { start: number; end?: number }>>,
  currentStep: number,
  now: number,
): Partial<Record<number, { start: number; end?: number }>> {
  const next: Partial<Record<number, { start: number; end?: number }>> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    const key = Number(k);
    if (key === currentStep) continue;
    if (v && v.end == null) next[key] = { start: v.start, end: now };
  }
  if (!next[currentStep]) {
    next[currentStep] = { start: now };
  }
  return next;
}

// closeStepTimings marks every still-open step as ended at `now`. Used
// when the task transitions to a terminal state so the last step's
// duration is shown as a final number rather than continuing to tick.
function closeStepTimings(
  prev: Partial<Record<number, { start: number; end?: number }>>,
  now: number,
): Partial<Record<number, { start: number; end?: number }>> {
  const next: Partial<Record<number, { start: number; end?: number }>> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v && v.end == null) next[Number(k)] = { start: v.start, end: now };
  }
  return next;
}
