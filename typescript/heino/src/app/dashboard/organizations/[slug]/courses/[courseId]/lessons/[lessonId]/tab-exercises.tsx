"use client";

import { useState, useEffect, useRef, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  SparklesIcon, Loader2Icon, LockIcon, Trash2Icon,
} from "lucide-react";
import type { TranscriptChunk, TranscriptSegment, ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import {
  AIService, GenerationStrategy, ChunkInteractionConfigSchema, GenerateInteractionsStep,
} from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode, InteractionKind, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { toast } from "sonner";
import { InteractionRow, type InteractionFormData, buildProtoConfig } from "./interaction-row";
import { ChunkSection } from "./chunk-section";
import { type ChunkGenPhase } from "./chunk-generate-form";
import { GenerateExercisesDialog } from "./generate-exercises-dialog";
import { fromConfig, toKindsList, totalQuantity, type KindQuantities } from "./kind-quantity-grid";

// ── Types ─────────────────────────────────────────────────────────────────────

type GenPhase =
  | { phase: "idle" }
  | { phase: "running"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

type ChunkFilter = "all" | "empty" | "has" | "default-cfg" | "custom-cfg";

// ── Props ─────────────────────────────────────────────────────────────────────

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
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TabExercises({
  lessonId, chunks, initialInteractions, token, disabled,
  genState, genWarnings,
  feedbackMode, savingFeedback, onFeedbackModeChange,
  openLessonGenerateRequest = 0,
  onGenerateLesson, onInteractionsChange,
  defaultInteractionConfig: initialDefaultCfg,
}: Props) {
  const router = useRouter();
  const aiClient = useRichterWebClient(AIService, token);
  const interactionClient = useRichterWebClient(InteractionService, token);
  const chunkAbortRefs = useRef<Record<string, AbortController>>({});

  // ── Data state ──────────────────────────────────────────────────────────────
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

  // ── Generate dialog state ───────────────────────────────────────────────────
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

  // ── Collapse / expand state ─────────────────────────────────────────────────
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());

  function toggleChunk(id: string) {
    setExpandedChunks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Search + filter state ───────────────────────────────────────────────────
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

  // ── Per-chunk add form state ────────────────────────────────────────────────
  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  // ── Per-chunk generate state ────────────────────────────────────────────────
  const [openGenerateChunkIds, setOpenGenerateChunkIds] = useState<Set<string>>(new Set());
  const [chunkGenState, setChunkGenState] = useState<Record<string, ChunkGenPhase>>({});
  const [deletingScope, setDeletingScope] = useState<"lesson" | string | null>(null);

  useEffect(() => {
    const chunkAbortControllers = chunkAbortRefs.current;
    return () => {
      Object.values(chunkAbortControllers).forEach((ctrl) => ctrl.abort());
    };
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function updateInteractions(updated: LessonInteraction[]) {
    interactionsRef.current = updated;
    setInteractions(updated);
    onInteractionsChange(updated);
  }

  function updateInteractionsFromCurrent(updater: (current: LessonInteraction[]) => LessonInteraction[]) {
    updateInteractions(updater(interactionsRef.current));
  }

  // ── Generate handler ────────────────────────────────────────────────────────

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

  // ── Add interaction ──────────────────────────────────────────────────────────

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

  // ── Open / close handlers ────────────────────────────────────────────────────

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

  // ── Per-chunk generate ───────────────────────────────────────────────────────

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
        for await (const event of aiClient.generateInteractionsStream(
          { lessonId, chunkId, forceRegenerate: true },
          { signal: ctrl.signal },
        )) {
          if (event.step === GenerateInteractionsStep.ERROR) {
            setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "error", message: event.message || "Lỗi tạo bài tập" } }));
            toast.error(`Lỗi tạo bài tập cho "${chunkSummary}"`);
            return;
          }
          if (event.step === GenerateInteractionsStep.DONE) {
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
          setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "running", message: event.message } }));
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

  // ── Render ───────────────────────────────────────────────────────────────────

  const isGenerating = genState.phase === "running";
  const hasChunks = localChunks.length > 0;
  const someChunkGenerating = Object.values(chunkGenState).some(s => s?.phase === "running");
  const isDeleting = deletingScope !== null;
  const isActuallyBusy = disabled || isGenerating || someChunkGenerating || isDeleting;
  const chunksWithConfigCount = localChunks.filter(c => !!c.interactionConfig).length;

  if (!hasChunks) {
    return (
      <div className="flex flex-col items-center justify-center p-10 text-center border border-dashed border-border/80 rounded-2xl bg-muted/5">
        <div className="rounded-full bg-muted/20 p-4 border border-border/40 mb-4">
          <LockIcon className="size-6 text-muted-foreground animate-pulse" />
        </div>
        <h3 className="text-sm font-semibold text-foreground/90">Thiết kế bài tập chưa sẵn sàng</h3>
        <p className="text-sm text-muted-foreground max-w-sm mt-2 leading-relaxed">
          Hoàn thành <strong>Bước 3: Phân đoạn</strong> trước để chia nội dung bài học thành các phần ngữ cảnh.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">

      {/* ── Header ── */}
      <div className="rounded-xl border border-border bg-gradient-to-r from-background to-muted/20 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          {/* Summary stats */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-center">
                <span className="text-3xl font-bold tabular-nums">{interactions.length}</span>
                <span className="text-xs text-muted-foreground">bài tập</span>
              </div>
              <div className="h-10 w-px bg-border" />
              <div className="flex flex-col items-center">
                <span className="text-3xl font-bold tabular-nums">
                  {exerciseSummary.chunksWithExercises}<span className="text-lg text-muted-foreground">/{localChunks.length}</span>
                </span>
                <span className="text-xs text-muted-foreground">phân đoạn</span>
              </div>
              {exerciseSummary.chunksWithoutExercises > 0 && (
                <>
                  <div className="h-10 w-px bg-border" />
                  <div className="flex flex-col items-center">
                    <span className="text-3xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
                      {exerciseSummary.chunksWithoutExercises}
                    </span>
                    <span className="text-xs text-muted-foreground">trống</span>
                  </div>
                </>
              )}
            </div>
            {/* Kind breakdown */}
            {interactions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {[
                  { kind: InteractionKind.SINGLE_CHOICE, label: "MCQ 1 đáp án", color: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400" },
                  { kind: InteractionKind.MULTIPLE_CHOICE, label: "MCQ nhiều đáp án", color: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400" },
                  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" },
                  { kind: InteractionKind.READING, label: "Bài đọc", color: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400" },
                  { kind: InteractionKind.LISTENING, label: "Bài nghe", color: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" },
                ].map(({ kind, label, color }) => {
                  const count = exerciseSummary.byKind.get(kind) ?? 0;
                  if (count === 0) return null;
                  return (
                    <span key={kind} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${color}`}>
                      {label}
                      <span className="bg-background/50 rounded-full px-1.5 py-0.5 text-xs font-bold">{count}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {/* Actions */}
          <div className="flex items-center gap-3 shrink-0">
            <select
              value={feedbackMode}
              disabled={savingFeedback || isActuallyBusy}
              onChange={(e) => onFeedbackModeChange(Number(e.target.value) as FeedbackMode)}
              className="text-sm rounded-lg border border-input bg-background px-3 py-2 text-foreground disabled:opacity-50"
            >
              <option value={FeedbackMode.HIDDEN}>Phản hồi: Ẩn</option>
              <option value={FeedbackMode.AFTER_SUBMIT}>Phản hồi: Sau khi nộp</option>
              <option value={FeedbackMode.AFTER_EACH}>Phản hồi: Sau mỗi câu</option>
            </select>
            {interactions.length > 0 && (
              <Button
                type="button"
                variant="destructive"
                disabled={isActuallyBusy}
                onClick={handleDeleteLessonInteractions}
                className="gap-2"
              >
                {deletingScope === "lesson" ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <Trash2Icon className="size-4" />
                )}
                Xóa tất cả
              </Button>
            )}
            {interactions.length > 0 && (
              <Button
                disabled={isActuallyBusy}
                onClick={() => setGenDialogOpen(true)}
                className="gap-2"
                data-testid="generate-all-btn"
              >
                {isGenerating ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SparklesIcon className="size-4" />
                )}
                {isGenerating ? "Đang tạo..." : "Tạo thêm"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Generation progress banner ── */}
      {isGenerating && genState.totalChunks > 0 && (
        <div className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 to-primary/10 px-5 py-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Loader2Icon className="size-4 animate-spin text-primary" />
              <p className="text-sm font-semibold">Đang tạo bài tập</p>
            </div>
            <p className="text-sm font-medium text-primary">
              {genState.chunkIndex + 1}/{genState.totalChunks}
            </p>
          </div>
          <div className="w-full bg-primary/20 rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${((genState.chunkIndex + 1) / genState.totalChunks) * 100}%` }}
            />
          </div>
          {genState.message && (
            <p className="text-xs text-muted-foreground mt-2.5">{genState.message}</p>
          )}
        </div>
      )}
      {genState.phase === "done" && (
        <div className="rounded-xl border border-green-200 dark:border-green-800 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 px-5 py-4">
          <p className="text-sm font-semibold text-green-700 dark:text-green-400" data-testid="gen-done">
            {genWarnings.length > 0
              ? `Hoàn thành (${genWarnings.length} đoạn gặp lỗi)`
              : "Tạo bài tập thành công!"}
          </p>
        </div>
      )}
      {genState.phase === "error" && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4" data-testid="gen-error">
          <p className="text-sm font-semibold text-destructive">Không thể tạo bài tập</p>
          <p className="text-xs text-destructive/70 mt-1">{genState.message}</p>
        </div>
      )}

      {/* ── Empty state CTA ── */}
      {interactions.length === 0 && !isGenerating && (
        <div className="flex flex-col items-center gap-5 py-12 rounded-2xl border-2 border-dashed border-primary/20 bg-gradient-to-b from-primary/5 to-transparent">
          <div className="rounded-2xl bg-primary/10 p-5 shadow-lg shadow-primary/10">
            <SparklesIcon className="size-10 text-primary" />
          </div>
          <div className="text-center max-w-lg">
            <h3 className="text-xl font-bold">Tạo bài tập bằng AI</h3>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              Tự động tạo câu hỏi trắc nghiệm, điền đáp án, bài đọc, bài nghe cho {localChunks.length} phân đoạn nội dung.
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              size="lg"
              onClick={() => setGenDialogOpen(true)}
              className="gap-2 px-8"
              data-testid="generate-all-btn"
            >
              <SparklesIcon className="size-5" />
              Bắt đầu tạo
            </Button>
          </div>
        </div>
      )}

      {/* ── Search + filter bar ── */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <input
            type="search"
            placeholder="Tìm phân đoạn..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full text-sm rounded-xl border border-input bg-background pl-10 pr-3 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <select
          value={chunkFilter}
          onChange={e => setChunkFilter(e.target.value as ChunkFilter)}
          className="text-sm rounded-xl border border-input bg-background px-3 py-2.5 text-foreground"
        >
          <option value="all">Tất cả</option>
          <option value="empty">Chưa có bài tập</option>
          <option value="has">Đã có bài tập</option>
          <option value="default-cfg">Cấu hình mặc định</option>
          <option value="custom-cfg">Cấu hình riêng</option>
        </select>
        {isFiltered && (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors px-2"
            onClick={() => { setSearchQuery(""); setChunkFilter("all"); }}
          >
            Xoá lọc
          </button>
        )}
      </div>

      {/* ── Chunk list ── */}
      <div className="flex flex-col gap-3">
        {filteredChunks.map((chunk) => (
          <ChunkSection
            key={chunk.id}
            chunk={chunk}
            interactions={interactions.filter(it => it.chunkId === chunk.id)}
            expanded={expandedChunks.has(chunk.id)}
            onToggle={() => toggleChunk(chunk.id)}
            isGenerating={openGenerateChunkIds.has(chunk.id) || chunkGenState[chunk.id]?.phase === "running"}
            isAdding={addingChunkId === chunk.id}
            chunkGen={chunkGenState[chunk.id]}
            lessonId={lessonId}
            token={token}
            disabled={disabled || isGenerating || isDeleting}
            addSaving={addSaving}
            addError={addError}
            onOpenGenerate={() => handleOpenGenerate(chunk.id)}
            onCloseGenerate={() => handleCloseGenerate(chunk.id)}
            onGenerate={(count, kinds, strategy) => handleChunkGenerate(chunk.id, count, kinds, strategy)}
            onOpenAdd={() => handleOpenAdd(chunk.id)}
            onCloseAdd={() => { setAddingChunkId(null); setAddError(null); }}
            onSaveAdd={(data) => handleAdd(chunk.id, data)}
            onDeleteAllInChunk={() => handleDeleteChunkInteractions(chunk.id)}
            onUpdate={(updated) => {
              updateInteractionsFromCurrent(prev =>
                prev.map(x => x.id === updated.id ? updated : x),
              );
              router.refresh();
            }}
            onDelete={(id) => {
              updateInteractionsFromCurrent(prev =>
                prev.filter(x => x.id !== id),
              );
              router.refresh();
            }}
          />
        ))}

        {filteredChunks.length === 0 && isFiltered && (
          <p className="text-sm text-muted-foreground text-center py-6">
            Không tìm thấy phân đoạn nào phù hợp.
          </p>
        )}

        {/* Orphan interactions */}
        {(() => {
          const orphans = interactions.filter(
            (it) => !it.chunkId || !localChunks.some((c) => c.id === it.chunkId),
          );
          if (orphans.length === 0) return null;
          return (
            <div className="rounded-lg border border-dashed border-border p-4">
              <p className="text-sm text-muted-foreground mb-3">
                Bài tập không thuộc phân đoạn nào ({orphans.length})
              </p>
              <div className="flex flex-col gap-2">
                {orphans.map((it, i) => (
                  <InteractionRow
                    key={it.id}
                    interaction={it}
                    index={i}
                    lessonId={lessonId}
                    token={token}
                    disabled={disabled}
                    onUpdate={(updated) => {
                      updateInteractionsFromCurrent(prev =>
                        prev.map(x => x.id === updated.id ? updated : x),
                      );
                      router.refresh();
                    }}
                    onDelete={(id) => {
                      updateInteractionsFromCurrent(prev =>
                        prev.filter(x => x.id !== id),
                      );
                      router.refresh();
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })()}
      </div>

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
