"use client";

import React, { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Loader2Icon, CheckIcon, XIcon,
  ChevronRightIcon, ChevronDownIcon, RefreshCwIcon, MergeIcon, Trash2Icon,
  PencilIcon, LockIcon, ScissorsIcon, ArrowUpIcon, ArrowDownIcon, PlayIcon,
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

// ── Tab types ─────────────────────────────────────────────────────────────────

type TabKey = "phienAm" | "doanNoidung" | "baiTap";

// ── Pipeline step wrapper ─────────────────────────────────────────────────────

type PipelineStepStatus = "locked" | "available" | "active" | "done" | "error";

function PipelineStep({
  number,
  title,
  pipelineStatus = "available",
  optional = false,
  collapsible = false,
  defaultOpen = true,
  isLast = false,
  children,
}: {
  number: number;
  title: string;
  pipelineStatus?: PipelineStepStatus;
  optional?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  isLast?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const locked = pipelineStatus === "locked";

  const badgeClass = {
    locked: "bg-muted text-muted-foreground border-muted-foreground/30",
    available: "border-border text-foreground bg-background",
    active: "border-blue-500 bg-blue-500 text-white",
    done: "border-green-500 bg-green-500 text-white",
    error: "border-destructive bg-destructive text-white",
  }[pipelineStatus];

  const titleClass = locked ? "text-muted-foreground" : "text-foreground";

  return (
    <div className="flex gap-3">
      {/* number badge + connector line */}
      <div className="flex flex-col items-center shrink-0">
        <div className={`size-7 rounded-full border-2 flex items-center justify-center text-xs font-semibold ${badgeClass}`}>
          {pipelineStatus === "done" ? <CheckIcon className="size-3.5" /> :
           pipelineStatus === "error" ? <XIcon className="size-3.5" /> :
           pipelineStatus === "active" ? <Loader2Icon className="size-3.5 animate-spin" /> :
           pipelineStatus === "locked" ? <LockIcon className="size-3" /> :
           number}
        </div>
        {!isLast && <div className="flex-1 w-px bg-border mt-1 mb-0" />}
      </div>

      {/* title + content */}
      <div className={`flex flex-col gap-2 ${isLast ? "pb-1" : "pb-5"} flex-1 min-w-0`}>
        <div className="flex items-center gap-1.5 min-h-7">
          <span className={`text-sm font-medium ${titleClass}`}>{title}</span>
          {optional && (
            <span className="text-xs text-muted-foreground border border-border/50 rounded px-1.5 py-px">
              Tuỳ chọn
            </span>
          )}
          {collapsible && !locked && (
            <button
              type="button"
              className="ml-auto p-0.5 rounded text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(o => !o)}
              aria-label={open ? "Thu gọn" : "Mở rộng"}
            >
              {open
                ? <ChevronDownIcon className="size-3.5" />
                : <ChevronRightIcon className="size-3.5" />}
            </button>
          )}
        </div>

        {!locked && (!collapsible || open) && children}
      </div>
    </div>
  );
}

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
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/40">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{chunk.summary}</p>
          <p className="text-xs text-muted-foreground">{formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}</p>
        </div>
        {chunkSegments.length > 0 && <CoherenceBadge score={chunk.coherenceScore} />}
        <div className="flex items-center gap-1 shrink-0">
          {prevChunkId && (
            <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs h-6"
              disabled={busy} onClick={() => onMergeWithPrev(chunk.id)} title="Gộp với đoạn trước">
              {isMerging ? <Loader2Icon className="size-3 animate-spin" /> : <MergeIcon className="size-3" />}
              Gộp lên
            </Button>
          )}
          {nextChunkId && (
            <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs h-6"
              disabled={busy} onClick={() => onMergeWithNext(chunk.id)} title="Gộp với đoạn sau">
              {isMerging ? <Loader2Icon className="size-3 animate-spin" /> : <MergeIcon className="size-3" />}
              Gộp xuống
            </Button>
          )}
          <Button variant="ghost" size="sm"
            className="gap-1 px-2 text-xs h-6 text-destructive hover:text-destructive"
            disabled={busy} onClick={() => onDelete(chunk.id)}>
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
              <div key={seg.startSeconds} className="flex items-start gap-2 px-2 py-1.5 text-xs group">
                <span className="text-muted-foreground tabular-nums shrink-0 pt-0.5">{formatTime(seg.startSeconds)}</span>
                <p className="flex-1 text-foreground leading-relaxed">{seg.text}</p>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                  {isFirstSeg && prevChunkId && !isLastSeg && (
                    <Button variant="ghost" size="sm"
                      className="px-1 text-xs h-5"
                      disabled={busy}
                      onClick={() => onMoveSegment(prevChunkId, chunk.id, nextSegStart ?? chunk.endSeconds, chunk.id)}
                      title="Chuyển lên đoạn trước">
                      {isMoving ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowUpIcon className="size-3" />}
                    </Button>
                  )}
                  {isLastSeg && nextChunkId && (
                    <Button variant="ghost" size="sm"
                      className="px-1 text-xs h-5"
                      disabled={busy}
                      onClick={() => onMoveSegment(chunk.id, nextChunkId, seg.startSeconds, chunk.id)}
                      title="Chuyển xuống đoạn sau">
                      {isMoving ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowDownIcon className="size-3" />}
                    </Button>
                  )}
                  {!isFirstSeg && (
                    <Button variant="ghost" size="sm"
                      className="gap-1 px-1.5 text-xs h-5"
                      disabled={busy} onClick={() => onSplit(chunk.id, seg.startSeconds)}
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

// ── Tab bar ───────────────────────────────────────────────────────────────────

function TabBar({
  active,
  onChange,
  tabs,
}: {
  active: TabKey;
  onChange: (t: TabKey) => void;
  tabs: { key: TabKey; label: string; dot?: "done" | "active" | "error" }[];
}) {
  return (
    <div className="flex border-b border-border mb-4">
      {tabs.map(({ key, label, dot }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={[
            "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
            active === key
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          ].join(" ")}
        >
          {label}
          {dot === "done" && (
            <span className="size-1.5 rounded-full bg-green-500 shrink-0" />
          )}
          {dot === "active" && (
            <Loader2Icon className="size-3 shrink-0 animate-spin text-blue-500" />
          )}
          {dot === "error" && (
            <span className="size-1.5 rounded-full bg-destructive shrink-0" />
          )}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  lessonId: string;
  initialChunks?: TranscriptChunk[];
  initialSegments?: TranscriptSegment[];
  initialStatus?: AnalysisStatus;
  initialInteractions?: LessonInteraction[];
  initialFeedbackMode?: FeedbackMode;
  initialDefaultInteractionConfig?: ChunkInteractionConfig;
  initialLanguage?: string;
  token: string;
}

export function AnalyzeButton({
  lessonId,
  initialChunks = [],
  initialSegments = [],
  initialStatus,
  initialInteractions = [],
  initialFeedbackMode = FeedbackMode.AFTER_SUBMIT,
  initialDefaultInteractionConfig,
  initialLanguage = "vi",
  token,
}: Props) {
  const router = useRouter();
  const aiClient = useRichterWebClient(AIService, token);
  const lessonClient = useRichterWebClient(LessonService, token);
  const [feedbackMode, setFeedbackMode] = useState<FeedbackMode>(initialFeedbackMode);
  const [savingFeedback, startSaveFeedback] = useTransition();
  const [language, setLanguage] = useState<string>(initialLanguage);
  const [savingLanguage, startSaveLanguage] = useTransition();

  function handleLanguageChange(lang: string) {
    setLanguage(lang);
    startSaveLanguage(async () => {
      try {
        await lessonClient.updateLesson({ id: lessonId, language: lang });
        router.refresh();
      } catch {
        setLanguage(language);
      }
    });
  }
  const abortRef = useRef<AbortController | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("phienAm");

  function handleFeedbackModeChange(mode: FeedbackMode) {
    setFeedbackMode(mode);
    startSaveFeedback(async () => {
      try {
        await lessonClient.updateLessonFeedbackMode({ id: lessonId, feedbackMode: mode });
        router.refresh();
      } catch {
        // revert on failure
        setFeedbackMode(feedbackMode);
      }
    });
  }
  const [status, setStatus] = useState<AnalysisStatus | undefined>(initialStatus);
  const [extractState, setExtractState] = useState<StreamRunState>(() => {
    if (initialStatus !== AnalysisStatus.PROCESSING) return { phase: "idle" };
    return initialSegments.length > 0 ? { phase: "done" } : { phase: "syncing" };
  });
  const [chunkState, setChunkState] = useState<StreamRunState>(() => {
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
  const [genState, setGenState] = useState<GenRunState>({ phase: "idle" });
  const [isReloadingChunks, setIsReloadingChunks] = useState(false);
  const [genWarnings, setGenWarnings] = useState<string[]>([]);
  const [mutatingError, setMutatingError] = useState<string | null>(null);
  const [confirmReExtract, setConfirmReExtract] = useState(false);
  const [interactions, setInteractions] = useState<LessonInteraction[]>(initialInteractions);

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
  }, [initialStatus]);

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
    router.refresh();
  }

  function startExtract() {
    setConfirmReExtract(false);
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
    } finally {
      setIsReloadingChunks(false);
    }
  }

  function handleChunk() {
    if (chunkState.phase === "running") return;
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

  function handleGenerate(force?: boolean, chunkId?: string) {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setGenState({ phase: "running", message: "Đang bắt đầu...", chunkIndex: 0, totalChunks: 0 });
    setGenWarnings([]);

    const shouldForce = force ?? questionsGenerated;

    (async () => {
      try {
        for await (const event of aiClient.generateInteractionsStream(
          { lessonId, chunkId: chunkId ?? "", forceRegenerate: shouldForce },
          { signal: abortController.signal },
        )) {
          if (event.step === GenerateInteractionsStep.ERROR) {
            setGenWarnings(prev => [...prev, event.message || "Lỗi tạo câu hỏi cho một đoạn"]);
            setGenState({ phase: "running", message: event.message || "Lỗi, tiếp tục đoạn khác...", chunkIndex: event.chunkIndex, totalChunks: event.totalChunks });
            continue;
          }
          if (event.step === GenerateInteractionsStep.DONE) {
            setGenState({ phase: "done" });
            reloadAfterGenerate();
            return;
          }
          setGenState({ phase: "running", message: event.message, chunkIndex: event.chunkIndex, totalChunks: event.totalChunks });
        }
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
  const questionsGenerated = genState.phase === "done" || status === AnalysisStatus.DONE || interactions.length > 0;

  const step2Status: PipelineStepStatus =
    isExtracting || isSyncing ? "active" :
    extractState.phase === "error" ? "error" :
    hasSegments ? "done" : "available";

  const step3Status: PipelineStepStatus = hasSegments ? "available" : "locked";

  const step4Status: PipelineStepStatus =
    !hasSegments ? "locked" :
    isChunking || isChunkSyncing ? "active" :
    chunkState.phase === "error" ? "error" :
    hasChunks ? "done" : "available";

  const step5Status: PipelineStepStatus = hasChunks ? "available" : "locked";

  const tabDefs: { key: TabKey; label: string; dot?: "done" | "active" | "error" }[] = [
    {
      key: "phienAm",
      label: "Phiên âm",
      dot: isExtracting || isSyncing ? "active" : extractState.phase === "error" ? "error" : hasSegments ? "done" : undefined,
    },
    {
      key: "doanNoidung",
      label: "Phân đoạn video",
      dot: isChunking || isChunkSyncing ? "active" : chunkState.phase === "error" ? "error" : hasChunks ? "done" : undefined,
    },
    {
      key: "baiTap",
      label: "Bài tập",
      dot: isGenerating ? "active" : genState.phase === "error" ? "error" : questionsGenerated ? "done" : undefined,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Language picker */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground shrink-0">Ngôn ngữ bài giảng:</span>
        <select
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          disabled={savingLanguage}
          className="text-xs rounded border border-input bg-background px-2 py-1"
        >
          <option value="vi">🇻🇳 Tiếng Việt</option>
          <option value="en">🇬🇧 English</option>
        </select>
        {savingLanguage && <span className="text-xs text-muted-foreground">Đang lưu…</span>}
      </div>

      <TabBar active={activeTab} onChange={setActiveTab} tabs={tabDefs} />

      {/* ── Tab 1: Phiên âm ── */}
      {activeTab === "phienAm" && (
        <div className="flex flex-col">
          {/* Step 1: Analyze */}
          <PipelineStep number={1} title="Phân tích bài giảng" pipelineStatus={step2Status}>
            <div className="flex flex-col gap-2">
              {!confirmReExtract && (
                <Button
                  variant="default"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => {
                    if (hasSegments) { setConfirmReExtract(true); return; }
                    startExtract();
                  }}
                  className="gap-2 w-fit"
                >
                  {isExtracting
                    ? <Loader2Icon className="size-4 animate-spin" />
                    : <PlayIcon className="size-4" />}
                  {isExtracting ? "Đang trích xuất…" :
                    hasSegments ? "Trích xuất lại transcript" : "Trích xuất transcript"}
                </Button>
              )}

              {confirmReExtract && (
                <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-xs flex flex-col gap-2">
                  <p className="text-amber-700 dark:text-amber-400">
                    Trích xuất lại sẽ <strong>xoá toàn bộ</strong> transcript, đoạn nội dung và câu hỏi hiện tại. Tiếp tục?
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm" variant="destructive" className="h-6 text-xs px-2"
                      onClick={() => startExtract()}
                    >
                      Xoá & trích xuất lại
                    </Button>
                    <Button
                      size="sm" variant="ghost" className="h-6 text-xs px-2"
                      onClick={() => setConfirmReExtract(false)}
                    >
                      Huỷ
                    </Button>
                  </div>
                </div>
              )}

              {isSyncing && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Tiến trình trước có vẻ bị gián đoạn. Bấm &ldquo;Phân tích lại&rdquo; để thử lại.
                </p>
              )}
              {extractState.phase !== "idle" && extractState.phase !== "syncing" && (
                <div data-testid="extract-progress">
                  <ProgressStrip steps={EXTRACT_STEPS} runState={extractState} stepTimings={extractTimings} now={now} />
                </div>
              )}
              {extractState.phase === "error" && (
                <p className="text-xs text-destructive" data-testid="extract-error">{extractState.message}</p>
              )}
            </div>
          </PipelineStep>

          {/* Step 2: Edit transcript */}
          <PipelineStep
            number={2} title="Chỉnh sửa transcript" pipelineStatus={step3Status}
            optional collapsible defaultOpen={true} isLast
          >
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-1">
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
          </PipelineStep>
        </div>
      )}

      {/* ── Tab 2: Đoạn nội dung ── */}
      {activeTab === "doanNoidung" && (
        <div className="flex flex-col">
          {/* Step 1: Re-chunk */}
          <PipelineStep number={1} title="Phân đoạn lại" pipelineStatus={step4Status} optional collapsible defaultOpen={!hasChunks}>
            <div className="flex flex-col gap-2">
              <Button
                variant={hasChunks ? "outline" : "default"}
                size="sm"
                disabled={isBusy}
                onClick={handleChunk}
                className="gap-2 w-fit"
              >
                {isChunking
                  ? <Loader2Icon className="size-4 animate-spin" />
                  : <RefreshCwIcon className="size-4" />}
                {isChunking ? "Đang phân đoạn…" : "Phân đoạn lại"}
              </Button>
              {isChunkSyncing && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Phân đoạn trước có vẻ bị gián đoạn. Bấm &ldquo;Phân đoạn lại&rdquo; để thử lại.
                </p>
              )}
              {chunkState.phase !== "idle" && chunkState.phase !== "syncing" && (
                <div data-testid="chunk-progress">
                  <ProgressStrip steps={CHUNK_STEPS} runState={chunkState} stepTimings={chunkTimings} now={now} />
                </div>
              )}
              {chunkState.phase === "error" && (
                <p className="text-xs text-destructive" data-testid="chunk-error">{chunkState.message}</p>
              )}
            </div>
          </PipelineStep>

          {/* Step 2: Edit chunks */}
          <PipelineStep
            number={2} title="Chỉnh sửa đoạn" pipelineStatus={step5Status}
            optional collapsible defaultOpen={false} isLast
          >
            <div className="flex flex-col gap-1.5">
              {isReloadingChunks ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3 animate-spin" /> Đang tải…
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
          </PipelineStep>

        </div>
      )}

      {/* ── Tab 3: Bài tập ── */}
      {activeTab === "baiTap" && (
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
          onFeedbackModeChange={handleFeedbackModeChange}
          onGenerateLesson={handleGenerate}
          onGenerateChunk={(chunkId, force) => handleGenerate(force, chunkId)}
          onInteractionsChange={setInteractions}
        />
      )}
    </div>
  );
}
