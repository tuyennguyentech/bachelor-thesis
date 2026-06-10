"use client";

import { useState, useEffect, useRef, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { TranscriptChunk, TranscriptSegment, ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import {
  AIService, GenerationStrategy, ChunkInteractionConfigSchema,
  GenerateInteractionsRequestSchema, LessonTaskKind, LessonTaskStatus,
} from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode, InteractionKind, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { uploadConfig } from "@/lib/client-config";
import { ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { toast } from "sonner";
import { type InteractionFormData, buildProtoConfig } from "./interaction-row";
import { type ChunkGenPhase } from "./chunk-generate-form";
import { ExerciseChunkList } from "./exercise-chunk-list";
import {
  EmptyExerciseState,
  ExerciseFilterBar,
  ExerciseOverviewHeader,
  GenerationStatusBanners,
  LockedExerciseState,
  type ChunkFilter,
} from "./exercise-overview";
import { type GenRunState as GenPhase } from "./use-lesson-analysis-state";
import { GenerateExercisesDialog } from "./generate-exercises-dialog";
import { fromConfig, toKindsList, totalQuantity, type KindQuantities } from "./kind-quantity-grid";

interface Props {
  lessonId: string;
  chunks: TranscriptChunk[];
  segments?: TranscriptSegment[];
  initialInteractions: LessonInteraction[];
  token: string;
  disabled: boolean;
  genState: GenPhase;
  genWarnings: string[];
  questionsGenerated?: boolean;
  feedbackMode: FeedbackMode;
  savingFeedback: boolean;
  openLessonGenerateRequest?: number;
  onFeedbackModeChange: (mode: FeedbackMode) => void;
  onGenerateLesson: (force?: boolean, difficulty?: string, focusPrompt?: string) => void;
  onGenerateChunk?: (chunkId: string, force: boolean) => void;
  onInteractionsChange: (interactions: LessonInteraction[]) => void;
  defaultInteractionConfig?: ChunkInteractionConfig;
  onCancel?: () => void;
  onRetry?: () => void;
}

export function TabExercises({
  lessonId, chunks, initialInteractions, token, disabled,
  genState, genWarnings,
  feedbackMode, savingFeedback, onFeedbackModeChange,
  openLessonGenerateRequest = 0,
  onGenerateLesson, onInteractionsChange,
  defaultInteractionConfig: initialDefaultCfg,
  onCancel,
  onRetry,
}: Props) {
  const router = useRouter();
  const aiClient = useRichterWebClient(AIService, token);
  const interactionClient = useRichterWebClient(InteractionService, token);
  const chunkAbortRefs = useRef<Record<string, AbortController>>({});

  const [interactions, setInteractions] = useState<LessonInteraction[]>(initialInteractions);
  const interactionsRef = useRef<LessonInteraction[]>(initialInteractions);
  const [localChunks, setLocalChunks] = useState<TranscriptChunk[]>(chunks);

  useEffect(() => {
    interactionsRef.current = initialInteractions;
    setInteractions(initialInteractions);
  }, [initialInteractions]);

  useEffect(() => {
    setLocalChunks(chunks);
  }, [chunks]);

  const [genDialogOpen, setGenDialogOpen] = useState(false);
  const defaultConfigSignature = initialDefaultCfg
    ? `${initialDefaultCfg.count}:${initialDefaultCfg.strategy}:${initialDefaultCfg.kinds.join(",")}`
    : "";
  const initialDefaultQuantities = useMemo(
    () => fromConfig(initialDefaultCfg),
    // Keep this tied to value-level config changes instead of protobuf object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultConfigSignature],
  );
  const [defaultQuantities, setDefaultQuantities] = useState<KindQuantities>(
    () => initialDefaultQuantities,
  );

  useEffect(() => {
    setDefaultQuantities(initialDefaultQuantities);
  }, [initialDefaultQuantities]);

  useEffect(() => {
    if (openLessonGenerateRequest > 0 && localChunks.length > 0 && genState.phase !== "running") {
      setGenDialogOpen(true);
    }
  }, [openLessonGenerateRequest, localChunks.length, genState.phase]);

  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());

  function toggleChunk(id: string) {
    setExpandedChunks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const [searchQuery, setSearchQuery] = useState("");
  const [chunkFilter, setChunkFilter] = useState<ChunkFilter>("all");

  const filteredChunks = useMemo(() => {
    return localChunks.filter(c => {
      if (searchQuery && !c.summary.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      const has = interactions.some(i => i.chunkId === c.id);
      if (chunkFilter === "empty" && has) return false;
      if (chunkFilter === "has" && !has) return false;
      if (chunkFilter === "default-cfg" && c.interactionConfig) return false;
      if (chunkFilter === "custom-cfg" && !c.interactionConfig) return false;
      return true;
    });
  }, [localChunks, interactions, searchQuery, chunkFilter]);

  const isFiltered = searchQuery !== "" || chunkFilter !== "all";
  const exerciseSummary = useMemo(() => {
    const byKind = new Map<InteractionKind, number>();
    interactions.forEach((it) => {
      byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
    });
    const chunksWithExercises = localChunks.filter((c) => interactions.some((it) => it.chunkId === c.id)).length;
    return {
      byKind,
      chunksWithExercises,
      chunksWithoutExercises: Math.max(0, localChunks.length - chunksWithExercises),
    };
  }, [interactions, localChunks]);

  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  const [openGenerateChunkIds, setOpenGenerateChunkIds] = useState<Set<string>>(new Set());
  const [chunkGenState, setChunkGenState] = useState<Record<string, ChunkGenPhase>>({});
  const [deletingScope, setDeletingScope] = useState<"lesson" | string | null>(null);

  useEffect(() => {
    const chunkAbortControllers = chunkAbortRefs.current;
    return () => {
      Object.values(chunkAbortControllers).forEach((ctrl) => ctrl.abort());
    };
  }, []);

  function updateInteractions(updated: LessonInteraction[]) {
    interactionsRef.current = updated;
    setInteractions(updated);
    onInteractionsChange(updated);
  }

  function updateInteractionsFromCurrent(updater: (current: LessonInteraction[]) => LessonInteraction[]) {
    updateInteractions(updater(interactionsRef.current));
  }

  async function handleGenDialogGenerate(force: boolean, difficulty: string, focusPrompt: string) {
    // Save default config first
    const configTotal = totalQuantity(defaultQuantities);
    if (configTotal > 0) {
      try {
        const kinds = toKindsList(defaultQuantities);
        await aiClient.updateLessonDefaultInteractionConfig({
          lessonId,
          defaultInteractionConfig: create(ChunkInteractionConfigSchema, {
            count: configTotal, kinds, strategy: GenerationStrategy.EVEN_DISTRIBUTION,
          }),
        });
      } catch {
        toast.error("Không thể lưu cấu hình mặc định");
        return;
      }
    }
    setGenDialogOpen(false);
    onGenerateLesson(force, difficulty, focusPrompt);
  }

  function handleAdd(chunkId: string, data: InteractionFormData) {
    setAddError(null);
    startAddSave(async () => {
      try {
        const res = await interactionClient.createManualInteraction({
          lessonId, chunkId,
          prompt: data.prompt,
          explanation: data.explanation,
          startSeconds: data.startSeconds,
          config: buildProtoConfig(data),
        });
        if (res.interaction) {
          const it = res.interaction;
          updateInteractionsFromCurrent(prev => [...prev, it]);
          setAddingChunkId(null);
          router.refresh();
        }
      } catch (err) {
        setAddError(err instanceof ConnectError ? err.message : "Không thể thêm câu hỏi");
      }
    });
  }

  function handleOpenGenerate(chunkId: string) {
    setExpandedChunks(prev => new Set(prev).add(chunkId));
    setAddingChunkId(null);
    setAddError(null);
    setOpenGenerateChunkIds(prev => new Set(prev).add(chunkId));
    setChunkGenState(prev => (
      prev[chunkId]?.phase === "running" ? prev : { ...prev, [chunkId]: { phase: "idle" } }
    ));
  }

  function handleOpenAdd(chunkId: string) {
    setExpandedChunks(prev => new Set(prev).add(chunkId));
    setOpenGenerateChunkIds(prev => {
      const next = new Set(prev);
      next.delete(chunkId);
      return next;
    });
    setAddingChunkId(chunkId);
    setAddError(null);
  }

  function handleCloseGenerate(chunkId: string) {
    setOpenGenerateChunkIds(prev => {
      const next = new Set(prev);
      next.delete(chunkId);
      return next;
    });
    setChunkGenState(prev => (
      prev[chunkId]?.phase === "running" ? prev : { ...prev, [chunkId]: { phase: "idle" } }
    ));
  }

  function handleChunkGenerate(chunkId: string, count: number, kinds: InteractionKind[], strategy: GenerationStrategy) {
    if (kinds.length === 0) return;
    const chunkSummary = localChunks.find(c => c.id === chunkId)?.summary ?? "phân đoạn này";
    if (chunkGenState[chunkId]?.phase === "running") return;
    chunkAbortRefs.current[chunkId]?.abort();
    const ctrl = new AbortController();
    chunkAbortRefs.current[chunkId] = ctrl;
    setOpenGenerateChunkIds(prev => new Set(prev).add(chunkId));
    setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "running", message: "Đang lưu cấu hình..." } }));

    (async () => {
      try {
        const cfgRes = await aiClient.updateChunkInteractionConfig({
          chunkId,
          interactionConfig: create(ChunkInteractionConfigSchema, { count, kinds, strategy }),
        });
        if (cfgRes.chunk) {
          setLocalChunks(prev => prev.map(c => c.id === chunkId ? cfgRes.chunk! : c));
        }
        setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "running", message: "Đang bắt đầu..." } }));

        // Enqueue the durable task and poll until it reaches a terminal
        // status. Replaces the previous generateInteractionsStream loop —
        // the server now exposes a long-running FDB-backed queue instead of
        // a streaming RPC. Cancellable via AbortController (the poller
        // simply stops iterating; the worker keeps running and produces
        // a result the user can ignore).
        const startRes = await aiClient.startLessonTask({
          lessonId,
          kind: LessonTaskKind.GENERATE_INTERACTIONS,
          generateInteractions: create(GenerateInteractionsRequestSchema, {
            lessonId,
            chunkId,
            forceRegenerate: true,
          }),
        });
        const taskId = startRes.task?.id;
        if (!taskId) {
          throw new Error("Server did not return a task id");
        }

        // Poll for terminal status. 1s cadence gives a smooth UI without
        // hammering the server. Visibility-aware pause is handled by the
        // browser — the page is hidden most of the time, so we don't need
        // a separate visibility observer here.
        for (;;) {
          if (ctrl.signal.aborted) return;
          const res = await aiClient.getLessonTask({ taskId });
          const t = res.task;
          if (!t) {
            throw new Error("Server returned an empty task");
          }
          if (t.status === LessonTaskStatus.SUCCEEDED) {
            const result = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
            const fresh = result?.analysis?.interactions;
            if (fresh) {
              const newForChunk = fresh.filter(i => i.chunkId === chunkId);
              updateInteractions(fresh);
              toast.success(`Đã tạo ${newForChunk.length} bài tập cho "${chunkSummary}"`);
            } else {
              toast.warning(`Tạo xong nhưng không tải được kết quả. Refresh trang.`);
            }
            setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "done" } }));
            setTimeout(() => {
              setOpenGenerateChunkIds(prev => {
                const next = new Set(prev);
                next.delete(chunkId);
                return next;
              });
              setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "idle" } }));
            }, 500);
            return;
          }
          if (t.status === LessonTaskStatus.FAILED) {
            setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "error", message: t.errorMsg || t.message || "Lỗi tạo bài tập" } }));
            toast.error(`Lỗi tạo bài tập cho "${chunkSummary}"`);
            return;
          }
          if (t.status === LessonTaskStatus.CANCELED) {
            setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "idle" } }));
            return;
          }
          if (t.message) {
            setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "running", message: t.message } }));
          }
          await new Promise<void>(resolve => setTimeout(resolve, uploadConfig.tabExercisesRetryMs));
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof ConnectError ? err.message : "Mất kết nối với máy chủ.";
        setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "error", message: msg } }));
        toast.error(`Lỗi tạo bài tập cho "${chunkSummary}"`);
      } finally {
        if (chunkAbortRefs.current[chunkId] === ctrl) {
          delete chunkAbortRefs.current[chunkId];
        }
      }
    })();
  }

  async function handleDeleteLessonInteractions() {
    if (interactionsRef.current.length === 0 || deletingScope) return;
    const ok = window.confirm("Xóa toàn bộ bài tập của bài học này? Hành động này không thể hoàn tác.");
    if (!ok) return;

    setDeletingScope("lesson");
    try {
      await interactionClient.deleteLessonInteractions({ lessonId });
      updateInteractions([]);
      router.refresh();
      toast.success("Đã xóa toàn bộ bài tập");
    } catch (err) {
      toast.error(err instanceof ConnectError ? err.message : "Không thể xóa bài tập");
    } finally {
      setDeletingScope(null);
    }
  }

  async function handleDeleteChunkInteractions(chunkId: string) {
    const chunkInteractions = interactionsRef.current.filter((it) => it.chunkId === chunkId);
    if (chunkInteractions.length === 0 || deletingScope) return;
    const chunkTitle = localChunks.find((c) => c.id === chunkId)?.summary ?? "phân đoạn này";
    const ok = window.confirm(`Xóa ${chunkInteractions.length} bài tập trong "${chunkTitle}"? Hành động này không thể hoàn tác.`);
    if (!ok) return;

    setDeletingScope(chunkId);
    try {
      await interactionClient.deleteLessonInteractions({ lessonId, chunkId });
      updateInteractionsFromCurrent((prev) => prev.filter((it) => it.chunkId !== chunkId));
      router.refresh();
      toast.success("Đã xóa bài tập của phân đoạn");
    } catch (err) {
      toast.error(err instanceof ConnectError ? err.message : "Không thể xóa bài tập của phân đoạn");
    } finally {
      setDeletingScope(null);
    }
  }

  const isGenerating = genState.phase === "running";
  const hasChunks = localChunks.length > 0;
  const someChunkGenerating = Object.values(chunkGenState).some(s => s?.phase === "running");
  const isDeleting = deletingScope !== null;
  const isActuallyBusy = disabled || isGenerating || someChunkGenerating || isDeleting;
  const chunksWithConfigCount = localChunks.filter(c => !!c.interactionConfig).length;

  if (!hasChunks) {
    return <LockedExerciseState />;
  }

  return (
    <div className="flex flex-col gap-5">

      {/* ── Header ── */}
      <ExerciseOverviewHeader
        chunksCount={localChunks.length}
        deletingLesson={deletingScope === "lesson"}
        feedbackMode={feedbackMode}
        interactionsCount={interactions.length}
        isBusy={isActuallyBusy}
        isGenerating={isGenerating}
        onDeleteAll={handleDeleteLessonInteractions}
        onFeedbackModeChange={onFeedbackModeChange}
        onOpenGenerate={() => setGenDialogOpen(true)}
        savingFeedback={savingFeedback}
        summary={exerciseSummary}
      />

      {/* ── Generation progress banner ── */}
      <GenerationStatusBanners
        genState={genState}
        genWarnings={genWarnings}
        onCancel={onCancel}
        onRetry={onRetry}
      />

      {/* ── Empty state CTA ── */}
      {interactions.length === 0 && !isGenerating && (
        <EmptyExerciseState
          chunksCount={localChunks.length}
          onOpenGenerate={() => setGenDialogOpen(true)}
        />
      )}

      {/* ── Search + filter bar ── */}
      <ExerciseFilterBar
        chunkFilter={chunkFilter}
        isFiltered={isFiltered}
        onChangeChunkFilter={setChunkFilter}
        onChangeSearchQuery={setSearchQuery}
        onClear={() => { setSearchQuery(""); setChunkFilter("all"); }}
        searchQuery={searchQuery}
      />

      {/* ── Chunk list ── */}
      <ExerciseChunkList
        addError={addError}
        addSaving={addSaving}
        addingChunkId={addingChunkId}
        chunkGenState={chunkGenState}
        disabled={disabled}
        expandedChunks={expandedChunks}
        filteredChunks={filteredChunks}
        interactions={interactions}
        isAddingDisabled={disabled || isGenerating || isDeleting}
        lessonId={lessonId}
        localChunks={localChunks}
        onCloseAdd={() => { setAddingChunkId(null); setAddError(null); }}
        onCloseGenerate={handleCloseGenerate}
        onDelete={(id) => {
          updateInteractionsFromCurrent(prev =>
            prev.filter(x => x.id !== id),
          );
          router.refresh();
        }}
        onDeleteAllInChunk={handleDeleteChunkInteractions}
        onGenerate={handleChunkGenerate}
        onOpenAdd={handleOpenAdd}
        onOpenGenerate={handleOpenGenerate}
        onSaveAdd={handleAdd}
        onToggleChunk={toggleChunk}
        onUpdate={(updated) => {
          updateInteractionsFromCurrent(prev =>
            prev.map(x => x.id === updated.id ? updated : x),
          );
          router.refresh();
        }}
        openGenerateChunkIds={openGenerateChunkIds}
        token={token}
      />

      {/* ── Generate dialog ── */}
      {genDialogOpen && (
        <GenerateExercisesDialog
          open={genDialogOpen}
          onOpenChange={setGenDialogOpen}
          chunksCount={localChunks.length}
          chunksWithExercisesCount={exerciseSummary.chunksWithExercises}
          chunksWithConfigCount={chunksWithConfigCount}
          interactionsCount={interactions.length}
          defaultQuantities={defaultQuantities}
          onDefaultQuantitiesChange={setDefaultQuantities}
          isGenerating={isGenerating}
          onGenerate={handleGenDialogGenerate}
        />
      )}
    </div>
  );
}
