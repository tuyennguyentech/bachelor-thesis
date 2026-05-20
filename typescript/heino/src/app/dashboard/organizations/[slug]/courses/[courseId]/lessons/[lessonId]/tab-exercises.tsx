"use client";

import { useState, useEffect, useRef, useTransition, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  SparklesIcon, Loader2Icon, RefreshCwIcon, LockIcon, SettingsIcon,
  ChevronDownIcon, ChevronRightIcon,
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
import { LessonWideGenForm } from "./lesson-wide-gen-form";

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
  questionsGenerated: boolean;
  feedbackMode: FeedbackMode;
  savingFeedback: boolean;
  onFeedbackModeChange: (mode: FeedbackMode) => void;
  onGenerateLesson: (force?: boolean) => void;
  onGenerateChunk?: (chunkId: string, force: boolean) => void;
  onInteractionsChange: (interactions: LessonInteraction[]) => void;
  defaultInteractionConfig?: ChunkInteractionConfig;
}

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

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

  useEffect(() => { setInteractions(initialInteractions); }, [initialInteractions]);

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
  const [defaultConfigSaved, setDefaultConfigSaved] = useState(!!initialDefaultCfg);

  // ── Lesson-wide gen form state ──────────────────────────────────────────────
  const [lessonGenFormOpen, setLessonGenFormOpen] = useState(false);
  const [lessonGenForce, setLessonGenForce] = useState(false);

  // Default force checkbox to true when there are existing interactions (snapshot on open).
  useEffect(() => {
    if (lessonGenFormOpen) setLessonGenForce(interactions.length > 0);
  }, [lessonGenFormOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Per-chunk add form state ────────────────────────────────────────────────
  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [addSaving, startAddSave] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  // ── Per-chunk generate state ────────────────────────────────────────────────
  const [generatingChunkId, setGeneratingChunkId] = useState<string | null>(null);
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
        setDefaultConfigSaved(true);
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

  // ── Open / close handlers ────────────────────────────────────────────────────

  function handleOpenGenerate(chunkId: string) {
    setExpandedChunks(prev => new Set(prev).add(chunkId));
    setAddingChunkId(null);
    setAddError(null);
    setGeneratingChunkId(chunkId);
    setChunkGenState(prev => ({ ...prev, [chunkId]: { phase: "idle" } }));
  }

  function handleOpenAdd(chunkId: string) {
    setExpandedChunks(prev => new Set(prev).add(chunkId));
    setGeneratingChunkId(null);
    setAddingChunkId(chunkId);
    setAddError(null);
  }

  // ── Per-chunk generate ───────────────────────────────────────────────────────

  function handleChunkGenerate(chunkId: string, count: number, kinds: InteractionKind[], strategy: GenerationStrategy) {
    if (kinds.length === 0) return;
    const chunkSummary = localChunks.find(c => c.id === chunkId)?.summary ?? "phân đoạn này";
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
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
              setGeneratingChunkId(null);
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
      }
    })();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const isGenerating = genState.phase === "running";
  const hasChunks = localChunks.length > 0;
  const someChunkGenerating = Object.values(chunkGenState).some(s => s?.phase === "running");

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
            disabled={disabled || !hasChunks || isGenerating || someChunkGenerating}
            onClick={() => setLessonGenFormOpen(o => !o)}
            className="gap-2"
            data-testid="generate-all-btn"
            title={someChunkGenerating ? "Đang tạo bài cho một phân đoạn, vui lòng chờ" : undefined}
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
          <LessonWideGenForm
            chunks={localChunks}
            interactionsCount={interactions.length}
            defaultCount={defaultCount}
            defaultKinds={defaultKinds}
            disabled={disabled}
            force={lessonGenForce}
            onForceChange={setLessonGenForce}
            onGenerate={() => { setLessonGenFormOpen(false); onGenerateLesson(lessonGenForce); }}
            onCancel={() => setLessonGenFormOpen(false)}
            hasDefaultConfig={defaultConfigSaved}
            onOpenDefaultConfig={() => { setLessonGenFormOpen(false); setExpandedConfig(true); }}
          />
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

      {/* ── Chunk list ── */}
      {hasChunks ? (
        <div className="flex flex-col gap-3">

          {/* Search + filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="search"
              placeholder="🔍 Tìm phân đoạn theo nội dung..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="flex-1 min-w-[180px] text-xs rounded border border-input bg-background px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground"
            />
            <select
              value={chunkFilter}
              onChange={e => setChunkFilter(e.target.value as ChunkFilter)}
              className="text-xs rounded border border-input bg-background px-2 py-1.5 text-foreground"
            >
              <option value="all">Tất cả phân đoạn</option>
              <option value="empty">Chưa có bài tập</option>
              <option value="has">Đã có bài tập</option>
              <option value="default-cfg">Dùng cấu hình mặc định</option>
              <option value="custom-cfg">Có cấu hình riêng</option>
            </select>
            {isFiltered && (
              <>
                <span className="text-xs text-muted-foreground">
                  {filteredChunks.length}/{localChunks.length} phân đoạn
                </span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => { setSearchQuery(""); setChunkFilter("all"); }}
                >
                  Reset ✕
                </button>
              </>
            )}
          </div>

          {filteredChunks.map((chunk) => (
            <ChunkSection
              key={chunk.id}
              chunk={chunk}
              interactions={interactions.filter(it => it.chunkId === chunk.id)}
              expanded={expandedChunks.has(chunk.id)}
              onToggle={() => toggleChunk(chunk.id)}
              isGenerating={generatingChunkId === chunk.id}
              isAdding={addingChunkId === chunk.id}
              chunkGen={chunkGenState[chunk.id]}
              lessonId={lessonId}
              token={token}
              disabled={disabled}
              addSaving={addSaving}
              addError={addError}
              onOpenGenerate={() => handleOpenGenerate(chunk.id)}
              onCloseGenerate={() => { setGeneratingChunkId(null); }}
              onGenerate={(count, kinds, strategy) => handleChunkGenerate(chunk.id, count, kinds, strategy)}
              onOpenAdd={() => handleOpenAdd(chunk.id)}
              onCloseAdd={() => { setAddingChunkId(null); setAddError(null); }}
              onSaveAdd={(data) => handleAdd(chunk.id, data)}
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

          {filteredChunks.length === 0 && isFiltered && (
            <p className="text-xs text-muted-foreground text-center py-4">
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
