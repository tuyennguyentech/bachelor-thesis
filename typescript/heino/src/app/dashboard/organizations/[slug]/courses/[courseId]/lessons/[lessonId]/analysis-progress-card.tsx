"use client";

import React, { memo } from "react";
import { LockIcon, Loader2Icon, PlayIcon, RefreshCwIcon, FileTextIcon, ListTreeIcon } from "lucide-react";
import {
  type HeroState,
  type PipelineStepStatus,
  type StreamRunState,
  CHUNK_STEPS,
  EXTRACT_STEPS,
  ProgressStrip,
  WorkflowProgressHero,
  WorkflowReadyState,
  WorkflowTaskSection,
} from "./analysis-workflow-ui";
import { ChunkEditor, getChunkSegments } from "./chunk-editor";
import { SegmentRow } from "./transcript-segment-row";
import type { TranscriptChunk, TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import type { AIClient } from "./use-lesson-analysis-state";

// ── Locked placeholder ──────────────────────────────────────────────────────

function LockedStepCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-10 text-center border border-dashed border-border/80 rounded-2xl bg-muted/5 shadow-inner">
      <div className="rounded-full bg-muted/20 p-4 border border-border/40 mb-3.5">
        <LockIcon className="size-6 text-muted-foreground animate-pulse" />
      </div>
      <h3 className="text-sm font-semibold text-foreground/90">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-sm mt-1.5 leading-relaxed">{description}</p>
    </div>
  );
}

// ── Extract progress card ───────────────────────────────────────────────────

interface ExtractProgressCardProps {
  runState: StreamRunState;
  timings: Partial<Record<number, { start: number; end?: number }>>;
  now: number;
  hasTranscriptContent: boolean;
  segmentsCount: number;
  confirmReExtract: boolean;
  onConfirmReExtract: () => void;
  onCancelConfirm: () => void;
  onStart: () => void;
  isBusy: boolean;
  /** Cancel handler for the active extract task (running / syncing / stale). */
  onCancel?: () => void;
  /** Retry handler for the stale / error hero. Cancels any active task then starts a new one. */
  onRetry?: () => void;
  /** Disables the cancel button while a cancel RPC is in flight. */
  cancelling?: boolean;
  /** Disables the retry button while a cancel+restart sequence is in flight. */
  retrying?: boolean;
}

export const ExtractProgressCard = memo(function ExtractProgressCard({
  runState,
  timings,
  now,
  hasTranscriptContent,
  segmentsCount,
  confirmReExtract,
  onConfirmReExtract,
  onCancelConfirm,
  onStart,
  isBusy,
  onCancel,
  onRetry,
  cancelling = false,
  retrying = false,
}: ExtractProgressCardProps) {
  const heroState: HeroState | null =
    runState.phase === "starting"  ? "starting" :
    runState.phase === "syncing"   ? "syncing" :
    runState.phase === "running"   ? "running" :
    runState.phase === "stale"     ? "stale" :
    runState.phase === "error"     ? "error" :
    runState.phase === "done"      ? "done" :
    null;
  const hasHero = heroState != null;
  const isError = runState.phase === "error";
  const isDone = runState.phase === "done";
  const isIdle = runState.phase === "idle";
  const showCta = (isIdle || isDone || isError) && !confirmReExtract;
  const isStartingOrSyncing = heroState === "starting" || heroState === "syncing";

  const currentStepLabel =
    (runState.phase === "running" || runState.phase === "stale") && runState.currentStep != null
      ? (EXTRACT_STEPS.find((s) => s.step === runState.currentStep)?.label ?? "Đang xử lý...")
      : "";
  const currentTiming =
    (runState.phase === "running" || runState.phase === "stale") && runState.currentStep != null
      ? timings[runState.currentStep]
      : undefined;
  const elapsedSec = currentTiming?.start
    ? Math.max(0, Math.floor((now - currentTiming.start) / 1000))
    : 0;

  const heroTitle =
    heroState === "starting"  ? "Đang khởi động tác vụ..." :
    heroState === "syncing"   ? "Đang đồng bộ với máy chủ..." :
    heroState === "running"   ? "Đang phiên âm" :
    heroState === "stale"     ? "Tác vụ có vẻ bị treo" :
    heroState === "error"     ? "Không thể phiên âm video" :
    heroState === "done"      ? "Đã có transcript" :
    "";
  const heroSubtitle =
    heroState === "stale"
      ? `Không có cập nhật trong ${formatHeroElapsedShort(elapsedSec)}. Có thể worker gặp sự cố — hãy hủy và thử lại.`
      : heroState === "error" && runState.phase === "error"
        ? (runState.message || "Hãy thử lại hoặc kiểm tra video có âm thanh rõ ràng.")
      : heroState === "done"
        ? (segmentsCount > 0
            ? `Transcript hiện có ${segmentsCount} đoạn. Bạn có thể chỉnh sửa trước khi phân đoạn.`
            : "Transcript đã có sẵn cho bài học này. Nếu cần chỉnh từng đoạn theo thời gian, hãy trích xuất lại từ video.")
      : currentStepLabel;

  const showElapsed = heroState === "running" || heroState === "stale" || heroState === "syncing";

  return (
    <WorkflowTaskSection
      title="Tác vụ phiên âm"
      status={
        heroState === "starting" || heroState === "syncing" || heroState === "running" || heroState === "stale" ? "active" :
        isError       ? "error"  :
        isDone || hasTranscriptContent ? "done" :
        "available"
      }
    >
      <div className="flex flex-col gap-3">
        {showCta && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (hasTranscriptContent) {
                onConfirmReExtract();
                return;
              }
              onStart();
            }}
            className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {isStartingOrSyncing ? <Loader2Icon className="size-4 animate-spin" /> : <PlayIcon className="size-4" />}
            {isStartingOrSyncing ? "Đang trích xuất..." : hasTranscriptContent ? "Trích xuất lại" : "Trích xuất transcript"}
          </button>
        )}

        {confirmReExtract && (
          <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-xs flex flex-col gap-2">
            <p className="font-medium text-amber-800 dark:text-amber-300">Trích xuất lại transcript?</p>
            <p className="text-amber-700 dark:text-amber-400">
              Transcript, phân đoạn và bài tập hiện tại sẽ bị xoá vì chúng gắn với video cũ.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="inline-flex h-6 items-center rounded bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                onClick={onStart}
              >
                Xoá và trích xuất lại
              </button>
              <button
                type="button"
                className="inline-flex h-6 items-center rounded px-2 text-xs font-medium text-foreground hover:bg-muted"
                onClick={onCancelConfirm}
              >
                Giữ nội dung hiện tại
              </button>
            </div>
          </div>
        )}

        {hasHero && (
          <WorkflowProgressHero
            state={heroState}
            title={heroTitle}
            subtitle={heroSubtitle}
            elapsedSec={elapsedSec}
            showElapsed={showElapsed}
            onCancel={onCancel}
            onRetry={onRetry}
            cancelling={cancelling}
            retrying={retrying}
            testId="extract-progress"
          >
            {heroState !== "done" && heroState !== "starting" && heroState !== "syncing" && (
              <ProgressStrip steps={EXTRACT_STEPS} runState={runState} stepTimings={timings} now={now} />
            )}
          </WorkflowProgressHero>
        )}
      </div>
    </WorkflowTaskSection>
  );
});

function formatHeroElapsedShort(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

// ── Chunk progress card ─────────────────────────────────────────────────────

interface ChunkProgressCardProps {
  runState: StreamRunState;
  timings: Partial<Record<number, { start: number; end?: number }>>;
  now: number;
  hasChunks: boolean;
  isBusy: boolean;
  onStart: () => void;
  /** Cancel handler for the active chunk task (running / syncing / stale). */
  onCancel?: () => void;
  /** Retry handler for the stale / error hero. Cancels any active task then starts a new one. */
  onRetry?: () => void;
  /** Disables the cancel button while a cancel RPC is in flight. */
  cancelling?: boolean;
  /** Disables the retry button while a cancel+restart sequence is in flight. */
  retrying?: boolean;
}

export const ChunkProgressCard = memo(function ChunkProgressCard({
  runState,
  timings,
  now,
  hasChunks,
  isBusy,
  onStart,
  onCancel,
  onRetry,
  cancelling = false,
  retrying = false,
}: ChunkProgressCardProps) {
  const heroState: HeroState | null =
    runState.phase === "starting"  ? "starting" :
    runState.phase === "syncing"   ? "syncing" :
    runState.phase === "running"   ? "running" :
    runState.phase === "stale"     ? "stale" :
    runState.phase === "error"     ? "error" :
    runState.phase === "done"      ? "done" :
    null;
  const hasHero = heroState != null;
  const isError = runState.phase === "error";
  const isDone = runState.phase === "done";
  const isIdle = runState.phase === "idle";
  const showCta = isIdle || isDone || isError;

  const status: PipelineStepStatus =
    heroState === "running" || heroState === "starting" || heroState === "syncing" || heroState === "stale" ? "active" :
    runState.phase === "error" ? "error" :
    hasChunks ? "done" : "available";

  const currentStepLabel = (runState.phase === "running" || runState.phase === "stale") && runState.currentStep != null
    ? (CHUNK_STEPS.find((s) => s.step === runState.currentStep)?.label ?? "Đang khởi động...")
    : "";
  const currentTiming = (runState.phase === "running" || runState.phase === "stale") && runState.currentStep != null
    ? timings[runState.currentStep]
    : undefined;
  const elapsedSec = currentTiming?.start
    ? Math.max(0, Math.floor((now - currentTiming.start) / 1000))
    : 0;

  const heroTitle =
    heroState === "starting"  ? "Đang khởi động tác vụ..." :
    heroState === "syncing"   ? "Đang đồng bộ với máy chủ..." :
    heroState === "running"   ? "Đang phân đoạn bài học" :
    heroState === "stale"     ? "Tác vụ có vẻ bị treo" :
    heroState === "error"     ? "Không thể phân đoạn bài học" :
    heroState === "done"      ? "Đã phân đoạn bài học" :
    "";
  
  const heroSubtitle =
    heroState === "stale"
      ? `Không có cập nhật trong ${formatHeroElapsedShort(elapsedSec)}. Có thể worker gặp sự cố — hãy hủy và thử lại.`
      : heroState === "error" && runState.phase === "error"
        ? (runState.message || "Transcript đã có, nhưng bước chia nội dung gặp lỗi. Hãy thử lại.")
      : heroState === "done"
        ? "Bài học hiện có các phân đoạn. Bạn có thể chỉnh sửa trước khi tạo bài tập."
        : currentStepLabel;

  const showElapsed = heroState === "running" || heroState === "stale" || heroState === "syncing";

  return (
    <WorkflowTaskSection
      title="Tác vụ phân đoạn"
      status={status}
      optional
      collapsible
      defaultOpen={!hasChunks || runState.phase === "error"}
    >
      <div className="flex flex-col gap-3">
        {showCta && hasChunks && (
          <button
            type="button"
            disabled={isBusy}
            onClick={onStart}
            className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
          >
            {heroState === "starting" || heroState === "syncing" ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
            {heroState === "starting" || heroState === "syncing" ? "Đang phân đoạn..." : "Phân đoạn lại"}
          </button>
        )}

        {hasHero && (
          <WorkflowProgressHero
            state={heroState}
            title={heroTitle}
            subtitle={heroSubtitle}
            elapsedSec={elapsedSec}
            showElapsed={showElapsed}
            onCancel={onCancel}
            onRetry={onRetry}
            cancelling={cancelling}
            retrying={retrying}
            testId="chunk-progress"
          >
            {heroState !== "done" && heroState !== "starting" && heroState !== "syncing" && (
              <ProgressStrip steps={CHUNK_STEPS} runState={runState} stepTimings={timings} now={now} />
            )}
          </WorkflowProgressHero>
        )}
      </div>
    </WorkflowTaskSection>
  );
});

// ── Transcript editor section ───────────────────────────────────────────────

interface TranscriptEditorSectionProps {
  segments: TranscriptSegment[];
  lessonId: string;
  isBusy: boolean;
  aiClient: AIClient;
  onSegmentUpdated: (index: number, text: string) => void;
  onSegmentSaved: () => void;
  status: PipelineStepStatus;
}

export const TranscriptEditorSection = memo(function TranscriptEditorSection({
  segments,
  lessonId,
  isBusy,
  aiClient,
  onSegmentUpdated,
  onSegmentSaved,
  status,
}: TranscriptEditorSectionProps) {
  return (
    <WorkflowTaskSection
      title="Chỉnh sửa transcript"
      status={status}
      optional
      collapsible
      defaultOpen
    >
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
        {segments.map((seg, i) => (
          <SegmentRow
            key={i}
            segment={seg}
            index={i}
            lessonId={lessonId}
            disabled={isBusy}
            aiClient={aiClient}
            onUpdated={onSegmentUpdated}
            // No router.refresh() here: onSegmentUpdated already updates local
            // segment state, and a soft RSC refresh of this heavy page wedges the
            // client router's transition lane — making the page tabs (?tab=...)
            // unclickable until a manual reload. Same fix already applied to the
            // task tracker + sync poller.
            onSaved={() => onSegmentSaved()}
          />
        ))}
      </div>
    </WorkflowTaskSection>
  );
});

// ── Chunk editor section ────────────────────────────────────────────────────

interface ChunkEditorSectionProps {
  chunks: TranscriptChunk[];
  segments: TranscriptSegment[];
  isBusy: boolean;
  isReloadingChunks: boolean;
  mutatingChunkId: string | null;
  mutatingOp: "merge" | "delete" | "split" | "move" | null;
  mutatingError: string | null;
  status: PipelineStepStatus;
  onMergeWithPrev: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDelete: (id: string) => void;
  onSplit: (id: string, splitAtSeconds: number) => void;
  onMoveSegment: (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) => void;
}

export const ChunkEditorSection = memo(function ChunkEditorSection({
  chunks,
  segments,
  isBusy,
  isReloadingChunks,
  mutatingChunkId,
  mutatingOp,
  mutatingError,
  status,
  onMergeWithPrev,
  onMergeWithNext,
  onDelete,
  onSplit,
  onMoveSegment,
}: ChunkEditorSectionProps) {
  return (
    <WorkflowTaskSection
      title="Chỉnh sửa phân đoạn"
      status={status}
      optional
      collapsible
      defaultOpen
    >
      <div className="flex flex-col gap-1.5">
        {isReloadingChunks ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" /> Đang tải...
          </div>
        ) : (
          chunks.map((chunk, i) => (
            <ChunkEditor
              key={chunk.id}
              chunk={chunk}
              chunkSegments={getChunkSegments(chunk, segments)}
              prevChunkId={i > 0 ? chunks[i - 1].id : null}
              nextChunkId={i < chunks.length - 1 ? chunks[i + 1].id : null}
              onMergeWithPrev={onMergeWithPrev}
              onMergeWithNext={onMergeWithNext}
              onDelete={onDelete}
              onSplit={onSplit}
              onMoveSegment={onMoveSegment}
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
    </WorkflowTaskSection>
  );
});

// ── Ready / locked placeholders ─────────────────────────────────────────────

export function TranscriptReadyState() {
  return (
    <WorkflowReadyState
      icon={<FileTextIcon className="size-4" />}
      title="Video sẵn sàng phiên âm"
      description="Video đã được tải lên và có thể được xử lý để tạo transcript cho các bước phân đoạn và bài tập."
    />
  );
}

export function ChunkReadyState({
  isBusy,
  onStart,
}: {
  isBusy: boolean;
  onStart: () => void;
}) {
  return (
    <div className="rounded-md border border-dashed border-border/70 bg-muted/10 px-4 py-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
            <ListTreeIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">Transcript sẵn sàng phân đoạn</p>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Chia transcript thành các phân đoạn học tập có ngữ cảnh rõ ràng trước khi tạo bài tập.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={isBusy}
          onClick={onStart}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          data-testid="start-chunk-from-ready"
        >
          <PlayIcon className="size-4" />
          Phân đoạn bài học
        </button>
      </div>
    </div>
  );
}

export function TranscriptLockedState() {
  return (
    <LockedStepCard
      title="Tính năng phiên âm chưa sẵn sàng"
      description="Vui lòng hoàn thành Bước 1: Tải video trước để tải tệp bài giảng lên hệ thống. AI cần tệp video để bắt đầu quá trình trích xuất âm thanh và tự động tạo transcript."
    />
  );
}

export function ChunkLockedState() {
  return (
    <LockedStepCard
      title="Tính năng phân đoạn chưa sẵn sàng"
      description="Vui lòng hoàn thành Bước 2: Phiên âm trước để tạo văn bản bài giảng. Sau khi có transcript, AI sẽ tự động phân tích cấu trúc bài giảng để chia thành các phân đoạn ngữ cảnh rõ ràng."
    />
  );
}
