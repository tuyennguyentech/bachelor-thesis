"use client";

import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toUserMessage } from "@/lib/connect-error";
import {
  AnalysisStatus,
  type TranscriptChunk,
  type TranscriptSegment,
  type LessonTask,
  LessonTaskKind,
  LessonTaskStatus,
} from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { toast } from "sonner";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { analysisConfig } from "@/lib/client-config";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import {
  type PipelineStepStatus,
  type StreamRunState,
  type WorkflowContentStepKey,
  getInitialWorkflowStep,
} from "./analysis-workflow-ui";
import { useLessonAnalysisSettings } from "./use-lesson-analysis-settings";
import { useLessonTasks } from "./use-lesson-tasks";
import { stepperReducer, type StepperState, type StepperAction } from "./analysis-stepper";
import { useAnalysisTaskTracker } from "./analysis-task-tracker";
import { useAnalysisChunkMutations } from "./analysis-chunk-mutations";

export type AIClient = ReturnType<typeof useRichterWebClient<typeof AIService>>;

export type GenRunState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "stale"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

type StepTimings = Partial<Record<number, { start: number; end?: number }>>;

type MutatingOp = "merge" | "delete" | "split" | "move";

export interface UseLessonAnalysisStateInput {
  lessonId: string;
  aiClient: AIClient;
  initialChunks: TranscriptChunk[];
  initialSegments: TranscriptSegment[];
  initialTranscript: string;
  initialStatus?: AnalysisStatus;
  initialErrorMsg?: string;
  initialInteractions: LessonInteraction[];
  initialFeedbackMode: FeedbackMode;
  initialLanguage: string;
  initialAudioLanguage: string;
  initialMaxAttempts: number;
  title: string;
  description: string;
  orderIndex: number;
  videoStorageKey?: string;
}

export interface UseLessonAnalysisState {
  // Stepper
  activeStep: WorkflowContentStepKey;
  setActiveStep: (step: WorkflowContentStepKey) => void;

  // Data
  segments: TranscriptSegment[];
  setSegments: React.Dispatch<React.SetStateAction<TranscriptSegment[]>>;
  chunks: TranscriptChunk[];
  interactions: LessonInteraction[];
  setInteractions: (i: LessonInteraction[]) => void;

  // Run states
  extractState: StreamRunState;
  chunkState: StreamRunState;
  genState: GenRunState;
  extractTimings: StepTimings;
  chunkTimings: StepTimings;
  now: number;

  // Settings + saving flags
  feedbackMode: FeedbackMode;
  setFeedbackMode: (m: FeedbackMode) => void;
  language: string;
  setLanguage: (l: string) => void;
  audioLanguage: string;
  setAudioLanguage: (l: string) => void;
  maxAttempts: number;
  setMaxAttempts: (n: number) => void;
  savingFeedback: boolean;
  savingLanguage: boolean;
  savingAudioLanguage: boolean;
  savingMaxAttempts: boolean;

  // UI flags
  mutatingChunkId: string | null;
  mutatingOp: MutatingOp | null;
  mutatingError: string | null;
  confirmReExtract: boolean;
  setConfirmReExtract: (b: boolean) => void;
  genWarnings: string[];
  exerciseOpenRequest: number;
  isReloadingChunks: boolean;
  bumpExerciseOpenRequest: () => void;

  // Derived
  hasSegments: boolean;
  hasChunks: boolean;
  hasTranscriptContent: boolean;
  questionsGenerated: boolean;
  isExtracting: boolean;
  isChunking: boolean;
  isGenerating: boolean;
  isSyncingExtract: boolean;
  isSyncingChunk: boolean;
  isMutating: boolean;
  isBusy: boolean;
  chunkGenerateBusy: boolean;
  step3Status: PipelineStepStatus;
  step5Status: PipelineStepStatus;

  // Handlers
  startExtract: () => void;
  handleChunk: () => void;
  handleGenerate: (force?: boolean, chunkId?: string, difficulty?: string, focusPrompt?: string) => void;
  handleMergeWithPrev: (chunkId: string) => Promise<void>;
  handleMergeWithNext: (chunkId: string) => Promise<void>;
  handleDeleteChunk: (chunkId: string) => Promise<void>;
  handleSplitChunk: (chunkId: string, splitAtSeconds: number) => Promise<void>;
  handleMoveSegment: (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) => Promise<void>;

  // Task list
  lessonTasks: LessonTask[];
  activeTasks: LessonTask[];
  connectionError: string | null;
  refreshTasks: () => Promise<void>;
  cancelTask: (taskId: string) => Promise<LessonTask | undefined>;
}

export function useLessonAnalysisState(input: UseLessonAnalysisStateInput): UseLessonAnalysisState {
  const {
    lessonId,
    aiClient,
    initialChunks,
    initialSegments,
    initialTranscript,
    initialStatus,
    initialErrorMsg,
    initialInteractions,
    initialFeedbackMode,
    initialLanguage,
    initialAudioLanguage,
    initialMaxAttempts,
    title,
    description,
    orderIndex,
    videoStorageKey,
  } = input;

  const { tasks: lessonTasks, activeTasks, lastError: taskPollError, refreshTasks, startTask, cancelTask } = useLessonTasks({
    aiClient,
    lessonId,
    enabled: !!videoStorageKey,
  });

  // ── Stepper ────────────────────────────────────────────────────────────────
  const [stepper, dispatchStep] = useReducer(stepperReducer, {
    activeStep: getInitialWorkflowStep(
      !!videoStorageKey,
      initialSegments,
      initialChunks,
      initialInteractions,
      initialTranscript,
      initialStatus,
    ),
  } satisfies StepperState);
  const setActiveStep = useCallback((step: WorkflowContentStepKey) => dispatchStep({ type: "SET_STEP", step } satisfies StepperAction), []);

  // ── Data ──────────────────────────────────────────────────────────────────
  const [segments, setSegments] = useState<TranscriptSegment[]>(initialSegments);
  const [chunks, setChunks] = useState<TranscriptChunk[]>(initialChunks);
  const [interactionsState, setInteractionsState] = useState<LessonInteraction[]>(initialInteractions);
  const setInteractions = useCallback((next: LessonInteraction[]) => setInteractionsState(next), []);

  // ── Run states ────────────────────────────────────────────────────────────
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
  const [genState, setGenState] = useState<GenRunState>(() =>
    initialStatus === AnalysisStatus.ERROR && initialChunks.length > 0
      ? { phase: "error", message: initialErrorMsg || "Thao tác thất bại." }
      : { phase: "idle" },
  );
  const [extractTimings, setExtractTimings] = useState<StepTimings>({});
  const [chunkTimings, setChunkTimings] = useState<StepTimings>({});
  const [genWarnings, setGenWarnings] = useState<string[]>([]);

  const {
    feedbackMode,
    language,
    audioLanguage,
    maxAttempts,
    savingFeedback,
    savingLanguage,
    savingAudioLanguage,
    savingMaxAttempts,
    setFeedbackMode,
    setLanguage,
    setAudioLanguage,
    setMaxAttempts,
  } = useLessonAnalysisSettings({
    description,
    initialFeedbackMode,
    initialLanguage,
    initialAudioLanguage,
    initialMaxAttempts,
    lessonId,
    orderIndex,
    title,
  });

  // ── Misc UI state ─────────────────────────────────────────────────────────
  const [confirmReExtract, setConfirmReExtract] = useState(false);
  const [exerciseOpenRequest, setExerciseOpenRequest] = useState(0);
  const bumpExerciseOpenRequest = useCallback(() => setExerciseOpenRequest((n) => n + 1), []);
  const hasActiveChunkTask = activeTasks.some((task) => task.kind === LessonTaskKind.CHUNK_TRANSCRIPT);

  // ── Refs for transition tracking ──────────────────────────────────────────
  const completedTaskIdsRef = useRef<Set<string>>(new Set());
  const startedTaskIdsRef = useRef<Set<string>>(new Set());
  const taskStatusByIdRef = useRef<Map<string, LessonTaskStatus>>(new Map());

  // ── Chunk mutations (extracted) ───────────────────────────────────────────
  const chunkMutations = useAnalysisChunkMutations({ lessonId, aiClient, chunks, setChunks });

  // ── Timer tick for progress display ───────────────────────────────────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const isRunning = extractState.phase === "running" || chunkState.phase === "running";
    if (!isRunning) return;
    const tickMs = analysisConfig.nowTickMs || 1000;
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [extractState.phase, chunkState.phase]);

  // ── Sync from props when RSC refreshes ────────────────────────────────────
  useEffect(() => { setSegments(initialSegments); }, [initialSegments]);
  useEffect(() => { setChunks(initialChunks); }, [initialChunks]);
  useEffect(() => { setInteractionsState(initialInteractions); }, [initialInteractions]);

  // ── Reset on PENDING status (new video uploaded) ──────────────────────────
  useEffect(() => {
    if (initialStatus !== AnalysisStatus.PENDING && initialStatus !== undefined) return;
    // Belt-and-suspenders: never wipe chunks/interactions that actually exist. A
    // transient PENDING/undefined status (e.g. a flaky GetLessonAnalysis) must not
    // erase real generated data and flip the stepper back to "fresh upload".
    if (initialChunks.length > 0 || initialInteractions.length > 0) return;
    setSegments([]);
    setChunks([]);
    setInteractionsState([]);
    setExtractState({ phase: "idle" });
    setChunkState({ phase: "idle" });
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    setExtractTimings({});
    setChunkTimings({});
    setConfirmReExtract(false);
    dispatchStep({
      type: "RESET",
      hasVideo: !!videoStorageKey,
      hasSegments: false,
      hasChunks: false,
      hasInteractions: false,
      hasTranscript: false,
    } satisfies StepperAction);
  }, [initialStatus, videoStorageKey, initialChunks.length, initialInteractions.length]);

  // ── Sync polling for stuck "syncing" phases ───────────────────────────────
  // The "syncing" phase is entered on page load when the BE is still
  // PROCESSING and we have no local data yet. We poll `getLessonAnalysis`
  // indefinitely (with backoff on network errors) and let the BE drive
  // state transitions: when the BE marks the task SUCCEEDED, FAILED, or
  // CANCELED, the analysis record's status flips and we react here. The
  // BE has its own reclaim + active-timeout for crashed workers
  // (`lessonTaskActiveTimeout`), so we deliberately do NOT add a
  // wall-clock timeout on top — that previously caused a red "lỗi" flash
  // for legitimately long-running extracts (videos >5 min) right before
  // the BE finally completed and the tracker would set "done".
  const isSyncingExtract = extractState.phase === "syncing";
  const isSyncingChunk = chunkState.phase === "syncing";
  useEffect(() => {
    if (!isSyncingExtract && !isSyncingChunk) return;
    const id = window.setInterval(async () => {
      try {
        const analysisResult = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
        const analysis = analysisResult?.analysis ?? null;
        const freshChunks = analysisResult?.chunks ?? [];
        if (!analysis || analysis.status === AnalysisStatus.PROCESSING) return;
        window.clearInterval(id);
        if (
          analysis.status === AnalysisStatus.TRANSCRIPT_EXTRACTED ||
          analysis.status === AnalysisStatus.CHUNKS_READY ||
          analysis.status === AnalysisStatus.DONE
        ) {
          setChunks(freshChunks);
          setSegments(analysis.transcriptSegments);
          if (isSyncingExtract) setExtractState({ phase: "done" });
          if (isSyncingChunk) setChunkState({ phase: "done" });
          dispatchStep({ type: "ADVANCE_AFTER_EXTRACT", hasChunks: freshChunks.length > 0 } satisfies StepperAction);
          // No router.refresh(): local state already reflects the freshly-loaded
          // segments/chunks. A soft RSC refresh here would wedge the page-level
          // ?tab= <Link> navigation (see useAnalysisTaskTracker for the rationale).
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
    }, analysisConfig.syncingPollMs || 5000);
    return () => window.clearInterval(id);
  }, [aiClient, isSyncingChunk, isSyncingExtract, lessonId]);

  // ── React to task state transitions (extracted) ──────────────────────────
  useAnalysisTaskTracker({
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
    reloadChunks: chunkMutations.reloadChunks,
    dispatchStep,
  });

  // ── Handlers: extract / chunk / generate ──────────────────────────────────
  const startExtract = useCallback(() => {
    setConfirmReExtract(false);
    dispatchStep({ type: "SET_STEP", step: "transcript" } satisfies StepperAction);
    // A (re-)transcribe wipes the old transcript + chunks + interactions server-side
    // (extract.go) the moment it starts. Clear them locally the instant the user
    // confirms, so the "Chỉnh sửa transcript" step AND the video tab stop showing the
    // stale transcript for the whole run — previously they kept the old content until
    // (and sometimes past) completion, so a re-transcribe looked like a no-op.
    setSegments([]);
    setChunks([]);
    setInteractionsState([]);
    setChunkState({ phase: "idle" });
    setChunkTimings({});
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    setExtractState({ phase: "running", currentStep: null });
    setExtractTimings({});
    void startTask(LessonTaskKind.EXTRACT_TRANSCRIPT)
      .then((task) => {
        if (task) {
          startedTaskIdsRef.current.add(task.id);
          taskStatusByIdRef.current.set(task.id, LessonTaskStatus.QUEUED);
        }
      })
      .catch((err) => {
        const msg = toUserMessage(err, "Không thể bắt đầu phiên âm.");
        setExtractState({ phase: "error", failedAt: null, message: msg });
        toast.error(msg);
      });
  }, [startTask]);

  const handleChunk = useCallback(() => {
    dispatchStep({ type: "SET_STEP", step: "chunks" } satisfies StepperAction);
    if (chunkState.phase === "running" || hasActiveChunkTask) {
      setChunkState({ phase: "running", currentStep: null });
      void refreshTasks().catch(() => {});
      return;
    }
    setGenState({ phase: "idle" });
    setGenWarnings([]);
    setChunkTimings({});
    setChunkState({ phase: "running", currentStep: null });
    void startTask(LessonTaskKind.CHUNK_TRANSCRIPT)
      .then((task) => {
        if (task) {
          startedTaskIdsRef.current.add(task.id);
          taskStatusByIdRef.current.set(task.id, LessonTaskStatus.QUEUED);
        }
      })
      .catch((err) => {
        const msg = toUserMessage(err, "Không thể bắt đầu phân đoạn.");
        setChunkState({ phase: "error", failedAt: null, message: msg });
        toast.error(msg);
      });
  }, [chunkState.phase, hasActiveChunkTask, refreshTasks, startTask]);

  const handleGenerate = useCallback(
    (force?: boolean, chunkId?: string, difficulty?: string, focusPrompt?: string) => {
      dispatchStep({ type: "SET_STEP", step: "exercises" } satisfies StepperAction);
      setGenState({ phase: "running", message: "Đang bắt đầu...", chunkIndex: 0, totalChunks: 0 });
      setGenWarnings([]);
      const shouldForce = force ?? interactionsState.length > 0;
      // Kinds/strategy/count come from the lesson's saved defaultInteractionConfig
      // (set by the "Tạo bài tập" dialog's KindQuantityGrid) — we deliberately do
      // NOT send interactionKinds here. Sending a global kinds list used to OVERRIDE
      // the dialog's config in the backend (resolveGenerationPlan), so picking e.g.
      // listening still produced a single MCQ. difficulty/focusPrompt come straight
      // from the generate dialog.
      void startTask(LessonTaskKind.GENERATE_INTERACTIONS, {
        lessonId,
        chunkId: chunkId ?? "",
        forceRegenerate: shouldForce,
        difficulty: difficulty || "",
        focusPrompt: focusPrompt || "",
      })
        .then((task) => {
          if (task) {
            startedTaskIdsRef.current.add(task.id);
            taskStatusByIdRef.current.set(task.id, LessonTaskStatus.QUEUED);
          }
        })
        .catch((err) => {
          const msg = toUserMessage(err, "Không thể bắt đầu tạo bài tập.");
          setGenState({ phase: "error", message: msg });
          toast.error(msg);
        });
    },
    [interactionsState.length, lessonId, startTask],
  );

  // ── Derived ──────────────────────────────────────────────────────────────
  const hasSegments = segments.length > 0;
  const hasChunks = chunks.length > 0;
  const questionsGenerated = interactionsState.length > 0;
  const hasTranscriptContent =
    hasSegments ||
    !!initialTranscript.trim() ||
    hasChunks ||
    questionsGenerated ||
    initialStatus === AnalysisStatus.TRANSCRIPT_EXTRACTED ||
    initialStatus === AnalysisStatus.CHUNKS_READY;

  const isExtracting = extractState.phase === "running";
  const isExtractingStarting = extractState.phase === "starting";
  const isExtractingStale = extractState.phase === "stale";
  const isSyncing = extractState.phase === "syncing";
  const isChunking = chunkState.phase === "running";
  const isChunkStarting = chunkState.phase === "starting";
  const isChunkStale = chunkState.phase === "stale";
  const isChunkSyncing = chunkState.phase === "syncing";
  const isGenerating = genState.phase === "running";
  const isGeneratingStarting = genState.phase === "starting";
  const isGeneratingStale = genState.phase === "stale";
  const isMutating = !!chunkMutations.mutatingChunkId;
  const isBusy = isExtracting || isExtractingStarting || isExtractingStale
    || isChunking || isChunkStarting || isChunkStale
    || isGenerating || isGeneratingStarting || isGeneratingStale
    || chunkMutations.isReloadingChunks || isMutating || activeTasks.length > 0;

  // Per-chunk exercise generation runs CONCURRENTLY across chunks (the backend caps it
  // at MaxActivePerUser). So the per-chunk "Tạo bài tập AI" gate must NOT treat OTHER
  // in-flight per-chunk generations as "busy" — only genuinely conflicting work
  // (transcript/chunk pipeline, a lesson-wide generate, chunk mutations, deletes). This
  // is the fix for "không tạo bài tập đồng thời cho nhiều chunk được": a lesson-wide
  // generate has an empty chunk_id, so it stays blocking; only real per-chunk gens are
  // excluded. (ZERO_UUID guard: an absent chunk_id may serialize as the nil UUID.)
  const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
  const activeBlockingTasks = activeTasks.filter(
    (t) => !(t.kind === LessonTaskKind.GENERATE_INTERACTIONS && !!t.chunkId && t.chunkId !== ZERO_UUID),
  );
  const chunkGenerateBusy = isExtracting || isExtractingStarting || isExtractingStale
    || isChunking || isChunkStarting || isChunkStale
    || isGenerating || isGeneratingStarting || isGeneratingStale
    || chunkMutations.isReloadingChunks || isMutating || activeBlockingTasks.length > 0;

  const step3Status: PipelineStepStatus = hasSegments ? "available" : "locked";
  const step5Status: PipelineStepStatus = hasChunks ? "available" : "locked";

  return {
    activeStep: stepper.activeStep,
    setActiveStep,
    segments, setSegments, chunks, interactions: interactionsState, setInteractions,
    extractState, chunkState,
    genState, extractTimings, chunkTimings, now,
    feedbackMode, setFeedbackMode, language, setLanguage, maxAttempts, setMaxAttempts,
    audioLanguage, setAudioLanguage, savingAudioLanguage,
    savingFeedback, savingLanguage, savingMaxAttempts,
    mutatingChunkId: chunkMutations.mutatingChunkId,
    mutatingOp: chunkMutations.mutatingOp,
    mutatingError: chunkMutations.mutatingError,
    confirmReExtract, setConfirmReExtract,
    genWarnings, exerciseOpenRequest,
    isReloadingChunks: chunkMutations.isReloadingChunks,
    bumpExerciseOpenRequest,
    hasSegments, hasChunks, hasTranscriptContent, questionsGenerated,
    isExtracting, isChunking, isGenerating, isSyncingExtract: isSyncing, isSyncingChunk: isChunkSyncing,
    isMutating, isBusy, chunkGenerateBusy,
    step3Status, step5Status,
    startExtract, handleChunk, handleGenerate,
    handleMergeWithPrev: chunkMutations.handleMergeWithPrev,
    handleMergeWithNext: chunkMutations.handleMergeWithNext,
    handleDeleteChunk: chunkMutations.handleDeleteChunk,
    handleSplitChunk: chunkMutations.handleSplitChunk,
    handleMoveSegment: chunkMutations.handleMoveSegment,
    lessonTasks, activeTasks, refreshTasks, cancelTask,
    connectionError: taskPollError ? toUserMessage(taskPollError) : null,
  };
}
