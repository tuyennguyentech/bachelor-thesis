"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  SparklesIcon, Loader2Icon, RefreshCwIcon, LockIcon, SettingsIcon,
  PlusIcon, ChevronDownIcon, ChevronRightIcon,
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
import {
  InteractionRow, InteractionForm, type InteractionFormData,
  emptyFormForKind, buildProtoConfig,
} from "./interaction-row";

// ── Constants ──────────────────────────────────────────────────────────────────

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
] as const;

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type GenPhase =
  | { phase: "idle" }
  | { phase: "running"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

type ChunkGenPhase =
  | { phase: "idle" }
  | { phase: "running"; message: string }
  | { phase: "done" }
  | { phase: "error"; message: string };

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
  questionsGenerated: boolean;
  feedbackMode: FeedbackMode;
  savingFeedback: boolean;
  onFeedbackModeChange: (mode: FeedbackMode) => void;
  onGenerateLesson: (force?: boolean) => void;
  onGenerateChunk?: (chunkId: string, force: boolean) => void;
  onInteractionsChange: (interactions: LessonInteraction[]) => void;
  defaultInteractionConfig?: ChunkInteractionConfig;
}

// ── Tab exercises ─────────────────────────────────────────────────────────────

export function TabExercises({
  lessonId, chunks, initialInteractions, token, disabled,
  genState, genWarnings, questionsGenerated,
  feedbackMode, savingFeedback, onFeedbackModeChange,
  onGenerateLesson, onInteractionsChange,
  defaultInteractionConfig: initialDefaultCfg,
}: Props) {
  const aiClient = useRichterWebClient(AIService, token);
  const interactionClient = useRichterWebClient(InteractionService, token);
  const abortRef = useRef<AbortController | null>(null);

  // ── Data state ──────────────────────────────────────────────────────────────
  const [interactions, setInteractions] = useState<LessonInteraction[]>(initialInteractions);
  const [localChunks, setLocalChunks] = useState<TranscriptChunk[]>(chunks);

  // Sync interactions when analyze-button reloads after lesson-wide generate
  useEffect(() => {
    setInteractions(initialInteractions);
  }, [initialInteractions]);

  // ── Default config state ────────────────────────────────────────────────────
  const [expandedConfig, setExpandedConfig] = useState(false);
  const [defaultCount, setDefaultCount] = useState(initialDefaultCfg?.count ?? 2);
  const [defaultKinds, setDefaultKinds] = useState<InteractionKind[]>(
    initialDefaultCfg?.kinds?.length ? [...initialDefaultCfg.kinds] : [InteractionKind.MCQ],
  );
  const [defaultStrategy, setDefaultStrategy] = useState<GenerationStrategy>(
    initialDefaultCfg?.strategy ?? GenerationStrategy.AI_CHOOSE,
  );
  const [savingDefaultCfg, startSaveDefaultCfg] = useTransition();
  const [defaultCfgError, setDefaultCfgError] = useState<string | null>(null);

  // ── Lesson-wide gen form state ──────────────────────────────────────────────
  const [lessonGenFormOpen, setLessonGenFormOpen] = useState(false);
  const [lessonGenForce, setLessonGenForce] = useState(false);

  // ── Per-chunk add form state ────────────────────────────────────────────────
  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [addingKind, setAddingKind] = useState<InteractionKind>(InteractionKind.MCQ);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  // ── Per-chunk generate form + streaming state ───────────────────────────────
  const [generatingChunkId, setGeneratingChunkId] = useState<string | null>(null);
  const [genFormCount, setGenFormCount] = useState(2);
  const [genFormKinds, setGenFormKinds] = useState<InteractionKind[]>([InteractionKind.MCQ]);
  const [genFormStrategy, setGenFormStrategy] = useState<GenerationStrategy>(GenerationStrategy.AI_CHOOSE);
  const [chunkGenState, setChunkGenState] = useState<Record<string, ChunkGenPhase>>({});

  useEffect(() => { return () => { abortRef.current?.abort(); }; }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function updateInteractions(updated: LessonInteraction[]) {
    setInteractions(updated);
    onInteractionsChange(updated);
  }

  // ── Default config ───────────────────────────────────────────────────────────

  function handleSaveDefaultCfg() {
    if (defaultKinds.length === 0) { setDefaultCfgError("Chọn ít nhất một loại."); return; }
    setDefaultCfgError(null);
    startSaveDefaultCfg(async () => {
      try {
        await aiClient.updateLessonDefaultInteractionConfig({
          lessonId,
          defaultInteractionConfig: create(ChunkInteractionConfigSchema, {
            count: defaultCount, kinds: defaultKinds, strategy: defaultStrategy,
          }),
        });
        setExpandedConfig(false);
      } catch (err) {
        setDefaultCfgError(err instanceof ConnectError ? err.message : "Không thể lưu cấu hình");
      }
    });
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
          setInteractions(prev => {
            const updated = [...prev, it];
            onInteractionsChange(updated);
            return updated;
          });
          setAddingChunkId(null);
        }
      } catch (err) {
        setAddError(err instanceof ConnectError ? err.message : "Không thể thêm câu hỏi");
      }
    });
  }

  // ── Per-chunk generate ───────────────────────────────────────────────────────

  function openChunkGenerate(chunk: TranscriptChunk) {
    const cfg = chunk.interactionConfig;
    setGeneratingChunkId(chunk.id);
    setGenFormCount(cfg?.count ?? 2);
    setGenFormKinds(cfg?.kinds?.length ? [...cfg.kinds] : [InteractionKind.MCQ]);
    setGenFormStrategy(cfg?.strategy ?? GenerationStrategy.AI_CHOOSE);
    setChunkGenState(prev => ({ ...prev, [chunk.id]: { phase: "idle" } }));
  }

  function handleChunkGenerate(chunkId: string) {
    if (genFormKinds.length === 0) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "running", message: "Đang lưu cấu hình..." } }));

    (async () => {
      try {
        const cfgRes = await aiClient.updateChunkInteractionConfig({
          chunkId,
          interactionConfig: create(ChunkInteractionConfigSchema, {
            count: genFormCount, kinds: genFormKinds, strategy: genFormStrategy,
          }),
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
            return;
          }
          if (event.step === GenerateInteractionsStep.DONE) {
            const result = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
            const fresh = result?.analysis?.interactions;
            if (fresh) updateInteractions(fresh);
            setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "done" } }));
            return;
          }
          setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "running", message: event.message } }));
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof ConnectError ? err.message : "Mất kết nối với máy chủ.";
        setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "error", message: msg } }));
      }
    })();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const isGenerating = genState.phase === "running";
  const hasChunks = localChunks.length > 0;

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header ── */}
      <div className="rounded-md border border-border bg-muted/20 p-3 flex flex-col gap-3">

        {/* Summary + feedback mode */}
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted-foreground flex-1">
            {hasChunks
              ? `${interactions.length} bài tập trong ${localChunks.length} phân đoạn`
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
            disabled={disabled || !hasChunks || isGenerating}
            onClick={() => { setLessonGenFormOpen(o => !o); setLessonGenForce(interactions.length > 0); }}
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

          <Button
            variant="ghost" size="sm" className="gap-1.5 text-muted-foreground"
            disabled={disabled}
            onClick={() => setExpandedConfig(o => !o)}
          >
            <SettingsIcon className="size-4" />
            Cấu hình mặc định
            {expandedConfig
              ? <ChevronDownIcon className="size-3" />
              : <ChevronRightIcon className="size-3" />}
          </Button>

          {!hasChunks && (
            <span className="text-xs text-muted-foreground border border-border/50 rounded px-1.5 py-px flex items-center gap-1">
              <LockIcon className="size-2.5" /> Cần phân đoạn trước
            </span>
          )}
        </div>

        {/* Inline default config panel */}
        {expandedConfig && (
          <div className="rounded-md border border-border p-3 bg-background flex flex-col gap-3">
            <p className="text-xs font-medium">Cấu hình mặc định cho cả lesson</p>
            <p className="text-xs text-muted-foreground">Áp dụng cho các phân đoạn chưa có cấu hình riêng</p>
            <div className="flex items-center gap-3">
              <label className="text-xs text-muted-foreground shrink-0">Số lượng:</label>
              <input
                type="number" min={1} max={8} value={defaultCount}
                onChange={(e) => setDefaultCount(Math.min(8, Math.max(1, parseInt(e.target.value) || 1)))}
                disabled={savingDefaultCfg}
                className="w-16 text-sm rounded border border-input bg-background px-2 py-1"
              />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">Loại:</p>
              <div className="flex flex-wrap gap-3">
                {KIND_OPTIONS.map(({ kind, label }) => (
                  <label key={kind} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={defaultKinds.includes(kind)}
                      onChange={() => setDefaultKinds(prev =>
                        prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind]
                      )}
                      disabled={savingDefaultCfg}
                    />
                    <span className="text-xs">{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">Chiến lược:</p>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="default-strategy"
                    checked={defaultStrategy === GenerationStrategy.AI_CHOOSE}
                    onChange={() => setDefaultStrategy(GenerationStrategy.AI_CHOOSE)}
                    disabled={savingDefaultCfg}
                  />
                  <span className="text-xs">AI chọn loại phù hợp nhất theo nội dung</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="default-strategy"
                    checked={defaultStrategy === GenerationStrategy.EVEN_DISTRIBUTION}
                    onChange={() => setDefaultStrategy(GenerationStrategy.EVEN_DISTRIBUTION)}
                    disabled={savingDefaultCfg}
                  />
                  <span className="text-xs">Phân bổ đều theo thứ tự đã chọn</span>
                </label>
              </div>
            </div>
            {defaultCfgError && <p className="text-xs text-destructive">{defaultCfgError}</p>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setExpandedConfig(false)} disabled={savingDefaultCfg}>Hủy</Button>
              <Button size="sm" onClick={handleSaveDefaultCfg}
                disabled={savingDefaultCfg || defaultKinds.length === 0} className="gap-1">
                {savingDefaultCfg && <Loader2Icon className="size-3 animate-spin" />}
                Lưu
              </Button>
            </div>
          </div>
        )}

        {/* Lesson-wide gen form */}
        {lessonGenFormOpen && !isGenerating && (
          <div className="rounded-md border border-border p-3 bg-background flex flex-col gap-2">
            <p className="text-xs font-medium">🤖 Tạo bài tập AI — Toàn lesson</p>
            {interactions.length > 0 && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox" checked={lessonGenForce}
                  onChange={(e) => setLessonGenForce(e.target.checked)}
                />
                <span className="text-xs">Thay thế bài tập hiện có ({interactions.length} bài)</span>
              </label>
            )}
            <div className="flex gap-2">
              <Button size="sm" className="gap-1"
                disabled={disabled}
                onClick={() => { setLessonGenFormOpen(false); onGenerateLesson(lessonGenForce); }}
              >
                <SparklesIcon className="size-3" />
                Tạo tất cả
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLessonGenFormOpen(false)}>Hủy</Button>
            </div>
          </div>
        )}

        {/* Lesson-wide gen progress */}
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

      {/* ── Chunk sections ── */}
      {hasChunks ? (
        <div className="flex flex-col gap-3">
          {localChunks.map((chunk) => {
            const chunkInteractions = interactions.filter((it) => it.chunkId === chunk.id);
            const chunkGen = chunkGenState[chunk.id];
            const isThisAdding = addingChunkId === chunk.id;
            const isThisGenerating = generatingChunkId === chunk.id;

            return (
              <div key={chunk.id} className="rounded-md border border-border overflow-hidden">

                {/* Chunk header */}
                <div className="flex items-start gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{chunk.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}
                      <span className="ml-2">
                        {chunkInteractions.length > 0
                          ? `${chunkInteractions.length} bài tập`
                          : "Chưa có bài tập"}
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
                    <Button
                      variant="ghost" size="sm" className="size-6 p-0"
                      title={isThisGenerating ? "Đóng form tạo AI" : "Tạo bài tập bằng AI"}
                      disabled={disabled || chunkGen?.phase === "running"}
                      onClick={() => {
                        if (isThisGenerating) { setGeneratingChunkId(null); }
                        else { setAddingChunkId(null); openChunkGenerate(chunk); }
                      }}
                    >
                      <SparklesIcon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost" size="sm" className="size-6 p-0"
                      title={isThisAdding ? "Đóng form thêm" : "Thêm bài tập thủ công"}
                      disabled={disabled}
                      onClick={() => {
                        if (isThisAdding) { setAddingChunkId(null); }
                        else {
                          setGeneratingChunkId(null);
                          setAddingChunkId(chunk.id);
                          setAddingKind(InteractionKind.MCQ);
                          setAddError(null);
                        }
                      }}
                      data-testid="add-interaction-btn"
                    >
                      <PlusIcon className="size-3" />
                    </Button>
                  </div>
                </div>

                {/* Chunk body */}
                <div className="flex flex-col gap-2 p-2">

                  {/* Inline per-chunk generate form */}
                  {isThisGenerating && (
                    <div className="rounded-md border border-border bg-background p-3 flex flex-col gap-2">
                      <p className="text-xs font-medium">🤖 Tạo bài tập AI — {chunk.summary}</p>

                      {chunkGen?.phase === "running" ? (
                        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <Loader2Icon className="size-3 animate-spin shrink-0" />
                          {chunkGen.message}
                        </p>
                      ) : chunkGen?.phase === "done" ? (
                        <p className="text-xs text-green-700 dark:text-green-400">✅ Hoàn thành</p>
                      ) : chunkGen?.phase === "error" ? (
                        <p className="text-xs text-destructive">❌ {chunkGen.message}</p>
                      ) : (
                        <>
                          {chunkInteractions.length > 0 && (
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                              ⚠ {chunkInteractions.length} bài tập hiện có sẽ bị thay thế
                            </p>
                          )}
                          <div className="flex items-center gap-3">
                            <label className="text-xs text-muted-foreground shrink-0">Số lượng:</label>
                            <input
                              type="number" min={1} max={8} value={genFormCount}
                              onChange={(e) => setGenFormCount(Math.min(8, Math.max(1, parseInt(e.target.value) || 1)))}
                              className="w-16 text-sm rounded border border-input bg-background px-2 py-1"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <p className="text-xs text-muted-foreground">Loại:</p>
                            <div className="flex flex-wrap gap-3">
                              {KIND_OPTIONS.map(({ kind, label }) => (
                                <label key={kind} className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={genFormKinds.includes(kind)}
                                    onChange={() => setGenFormKinds(prev =>
                                      prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind]
                                    )}
                                  />
                                  <span className="text-xs">{label}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            <p className="text-xs text-muted-foreground">Chiến lược:</p>
                            <div className="flex flex-col gap-1">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input type="radio" name={`gen-strat-${chunk.id}`}
                                  checked={genFormStrategy === GenerationStrategy.AI_CHOOSE}
                                  onChange={() => setGenFormStrategy(GenerationStrategy.AI_CHOOSE)}
                                />
                                <span className="text-xs">AI chọn loại phù hợp nhất</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input type="radio" name={`gen-strat-${chunk.id}`}
                                  checked={genFormStrategy === GenerationStrategy.EVEN_DISTRIBUTION}
                                  onChange={() => setGenFormStrategy(GenerationStrategy.EVEN_DISTRIBUTION)}
                                />
                                <span className="text-xs">Phân bổ đều theo thứ tự đã chọn</span>
                              </label>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" className="gap-1"
                              disabled={disabled || genFormKinds.length === 0}
                              onClick={() => handleChunkGenerate(chunk.id)}
                            >
                              <SparklesIcon className="size-3" />
                              Tạo bằng AI
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setGeneratingChunkId(null)}>Hủy</Button>
                          </div>
                        </>
                      )}

                      {(chunkGen?.phase === "done" || chunkGen?.phase === "error") && (
                        <Button size="sm" variant="ghost" className="self-start"
                          onClick={() => setGeneratingChunkId(null)}>
                          Đóng
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Interaction rows */}
                  {chunkInteractions.length === 0 && !isThisAdding && !isThisGenerating && (
                    <p className="text-xs text-muted-foreground px-1 py-1">Chưa có bài tập nào.</p>
                  )}
                  {chunkInteractions.map((it, i) => (
                    <InteractionRow
                      key={it.id}
                      interaction={it}
                      index={i}
                      lessonId={lessonId}
                      token={token}
                      disabled={disabled}
                      onUpdate={(updated) => setInteractions(prev => {
                        const next = prev.map(x => x.id === updated.id ? updated : x);
                        onInteractionsChange(next);
                        return next;
                      })}
                      onDelete={(id) => setInteractions(prev => {
                        const next = prev.filter(x => x.id !== id);
                        onInteractionsChange(next);
                        return next;
                      })}
                    />
                  ))}

                  {/* Inline add form */}
                  {isThisAdding && (
                    <div className="rounded-md border border-border bg-background p-2 flex flex-col gap-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        ➕ Thêm bài tập — {formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}
                      </p>
                      <div className="flex gap-1 flex-wrap">
                        {KIND_OPTIONS.map(({ kind, label }) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => { setAddingKind(kind); setAddError(null); }}
                            className={[
                              "text-xs px-2.5 py-1 rounded-md border transition-colors",
                              addingKind === kind
                                ? "border-foreground bg-foreground text-background"
                                : "border-border text-muted-foreground hover:border-foreground/50",
                            ].join(" ")}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <InteractionForm
                        key={addingKind}
                        initial={{ ...emptyFormForKind(addingKind), startSeconds: chunk.startSeconds }}
                        onSave={(data) => handleAdd(chunk.id, data)}
                        onCancel={() => { setAddingChunkId(null); setAddError(null); }}
                        saving={addSaving}
                        error={addError}
                        lessonId={lessonId}
                        token={token}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Orphan interactions */}
          {(() => {
            const orphans = interactions.filter(
              (it) => !it.chunkId || !localChunks.some((c) => c.id === it.chunkId),
            );
            if (orphans.length === 0) return null;
            return (
              <div className="rounded-md border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground mb-2">
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
                      onUpdate={(updated) => setInteractions(prev => {
                        const next = prev.map(x => x.id === updated.id ? updated : x);
                        onInteractionsChange(next);
                        return next;
                      })}
                      onDelete={(id) => setInteractions(prev => {
                        const next = prev.filter(x => x.id !== id);
                        onInteractionsChange(next);
                        return next;
                      })}
                    />
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
