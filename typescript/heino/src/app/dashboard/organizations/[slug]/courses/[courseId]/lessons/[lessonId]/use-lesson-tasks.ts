"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AIService,
  type GenerateInteractionsRequest,
  type LessonTask,
  LessonTaskKind,
  LessonTaskStatus,
} from "buf/gen/richter/v1/ai_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { lessonTasksConfig } from "@/lib/client-config";

type AIClient = ReturnType<typeof useRichterWebClient<typeof AIService>>;

export function isLessonTaskActive(task: LessonTask) {
  return task.status === LessonTaskStatus.QUEUED || task.status === LessonTaskStatus.RUNNING;
}

type PollOptions = {
  aiClient: AIClient;
  lessonId: string;
  enabled: boolean;
  /** Base interval (ms) when tab is visible and network is healthy. */
  baseIntervalMs?: number;
  /** Maximum backoff interval (ms) when consecutive polls error. */
  maxBackoffMs?: number;
};

type PollState = {
  tasks: LessonTask[];
  /** Wall-clock timestamp of the last successful poll. */
  lastSuccessAt: number | null;
  /** Last error message; cleared on next success. */
  lastError: string | null;
};

/**
 * Polls the lesson task list. Pauses while the tab is hidden (`document.hidden`)
 * and backs off on consecutive network errors. The returned `refreshTasks` is
 * the manual escape hatch (the panel refresh button).
 */
function useTaskPolling({
  aiClient,
  lessonId,
  enabled,
  baseIntervalMs = lessonTasksConfig.baseIntervalMs,
  maxBackoffMs = lessonTasksConfig.maxBackoffMs,
}: PollOptions) {
  const [state, setState] = useState<PollState>({ tasks: [], lastSuccessAt: null, lastError: null });
  // Track latest result for rAF coalescing — `refreshTasks` may resolve out of
  // order with the most recent in-flight call, so we hold a ref to the latest
  // payload and apply it on the next animation frame.
  const pendingRef = useRef<LessonTask[] | null>(null);
  const rafRef = useRef<number | null>(null);
  const failuresRef = useRef(0);

  const applyPending = useCallback(() => {
    rafRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next !== null) {
      setState(() => ({
        tasks: next,
        lastSuccessAt: Date.now(),
        lastError: null,
      }));
      failuresRef.current = 0;
    }
  }, []);

  const scheduleApply = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      applyPending();
      return;
    }
    rafRef.current = window.requestAnimationFrame(applyPending);
  }, [applyPending]);

  const refreshTasks = useCallback(async () => {
    if (!enabled) {
      pendingRef.current = [];
      scheduleApply();
      return;
    }
    try {
      const res = await aiClient.listLessonTasks({ lessonId, activeOnly: false, limit: 10, offset: 0 });
      pendingRef.current = res.tasks;
      scheduleApply();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "polling failed";
      failuresRef.current += 1;
      setState(prev => ({ ...prev, lastError: msg }));
    }
  }, [aiClient, enabled, lessonId, scheduleApply]);

  useEffect(() => {
    if (!enabled) {
      // Clear stale tasks from a previous enabled period. We intentionally
      // bypass the derived-state pattern because the consumer relies on the
      // hook returning an empty list as soon as the flag flips to false.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ tasks: [], lastSuccessAt: null, lastError: null });
      return;
    }
    failuresRef.current = 0;
    let timeoutId: number | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      void refreshTasks();
    };

    const scheduleNext = () => {
      if (cancelled) return;
      // Visibility-aware pause: when the tab is hidden, wait for the next
      // visibilitychange event before scheduling the next tick. This avoids
      // hammering the server from backgrounded tabs while still picking up
      // fresh data within one poll cycle of the user coming back.
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      const backoff = Math.min(maxBackoffMs, baseIntervalMs * Math.pow(2, Math.max(0, failuresRef.current - 1)));
      const interval = failuresRef.current === 0 ? baseIntervalMs : backoff;
      timeoutId = window.setTimeout(() => {
        tick();
        scheduleNext();
      }, interval);
    };

    const onVisibilityChange = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (document.hidden) {
        return;
      }
      // Tab is visible again — poll once immediately, then resume the schedule.
      tick();
      scheduleNext();
    };

    // Initial poll: fire and forget, then enter the recursive schedule.
    tick();
    scheduleNext();

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (rafRef.current !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(rafRef.current);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [baseIntervalMs, enabled, maxBackoffMs, refreshTasks]);

  return { tasks: state.tasks, lastError: state.lastError, refreshTasks };
}

/**
 * Lesson task hook. Returns the live task list (polled with visibility-aware
 * backoff) plus mutation helpers (start / cancel). All mutations trigger a
 * refresh so the panel picks up the new task state without waiting for the
 * next poll cycle.
 */
export function useLessonTasks({
  aiClient,
  lessonId,
  enabled,
}: {
  aiClient: AIClient;
  lessonId: string;
  enabled: boolean;
}) {
  const { tasks, lastError, refreshTasks } = useTaskPolling({ aiClient, lessonId, enabled });
  const activeTasks = useMemo(() => tasks.filter(isLessonTaskActive), [tasks]);

  const startTask = useCallback(
    async (kind: LessonTaskKind, generateInteractions?: Partial<GenerateInteractionsRequest>) => {
      const res = await aiClient.startLessonTask({
        lessonId,
        kind,
        generateInteractions: generateInteractions
          ? {
              lessonId,
              chunkId: generateInteractions.chunkId ?? "",
              forceRegenerate: generateInteractions.forceRegenerate ?? false,
              interactionKind: generateInteractions.interactionKind ?? 0,
              interactionKinds: generateInteractions.interactionKinds ?? [],
              countPerChunk: generateInteractions.countPerChunk ?? 0,
              strategy: generateInteractions.strategy ?? 0,
              difficulty: generateInteractions.difficulty ?? "",
              focusPrompt: generateInteractions.focusPrompt ?? "",
            }
          : undefined,
      });
      await refreshTasks().catch(() => {});
      return res.task;
    },
    [aiClient, lessonId, refreshTasks],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      const res = await aiClient.cancelLessonTask({ taskId });
      await refreshTasks().catch(() => {});
      return res.task;
    },
    [aiClient, refreshTasks],
  );

  return { tasks, activeTasks, lastError, refreshTasks, startTask, cancelTask };
}
