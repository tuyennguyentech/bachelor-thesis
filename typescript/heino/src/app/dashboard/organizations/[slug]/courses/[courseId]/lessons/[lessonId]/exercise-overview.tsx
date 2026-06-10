"use client";

import { Loader2Icon, SparklesIcon, Trash2Icon } from "lucide-react";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { WorkflowProgressHero } from "./analysis-workflow-ui";

// Re-exported as a named type so tab-exercises.tsx and friends can use
// a stable name without coupling to the analysis-state hook file.
export type GenPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "stale"; message: string; chunkIndex: number; totalChunks: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

export type ChunkFilter = "all" | "empty" | "has" | "default-cfg" | "custom-cfg";

export interface ExerciseSummary {
  byKind: Map<InteractionKind, number>;
  chunksWithExercises: number;
  chunksWithoutExercises: number;
}

const KIND_BADGES = [
  { kind: InteractionKind.SINGLE_CHOICE, label: "MCQ 1 đáp án", color: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400" },
  { kind: InteractionKind.MULTIPLE_CHOICE, label: "MCQ nhiều đáp án", color: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" },
  { kind: InteractionKind.READING, label: "Bài đọc", color: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe", color: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" },
];

interface ExerciseOverviewHeaderProps {
  chunksCount: number;
  deletingLesson: boolean;
  feedbackMode: FeedbackMode;
  interactionsCount: number;
  isBusy: boolean;
  isGenerating: boolean;
  onDeleteAll: () => void;
  onFeedbackModeChange: (mode: FeedbackMode) => void;
  onOpenGenerate: () => void;
  savingFeedback: boolean;
  summary: ExerciseSummary;
}

export function ExerciseOverviewHeader({
  chunksCount,
  deletingLesson,
  feedbackMode,
  interactionsCount,
  isBusy,
  isGenerating,
  onDeleteAll,
  onFeedbackModeChange,
  onOpenGenerate,
  savingFeedback,
  summary,
}: ExerciseOverviewHeaderProps) {
  return (
    <div className="rounded-xl border border-border bg-gradient-to-r from-background to-muted/20 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-center">
              <span className="text-3xl font-bold tabular-nums">{interactionsCount}</span>
              <span className="text-xs text-muted-foreground">bài tập</span>
            </div>
            <div className="h-10 w-px bg-border" />
            <div className="flex flex-col items-center">
              <span className="text-3xl font-bold tabular-nums">
                {summary.chunksWithExercises}<span className="text-lg text-muted-foreground">/{chunksCount}</span>
              </span>
              <span className="text-xs text-muted-foreground">phân đoạn</span>
            </div>
            {summary.chunksWithoutExercises > 0 && (
              <>
                <div className="h-10 w-px bg-border" />
                <div className="flex flex-col items-center">
                  <span className="text-3xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
                    {summary.chunksWithoutExercises}
                  </span>
                  <span className="text-xs text-muted-foreground">trống</span>
                </div>
              </>
            )}
          </div>
          {interactionsCount > 0 && (
            <div className="flex flex-wrap gap-2">
              {KIND_BADGES.map(({ kind, label, color }) => {
                const count = summary.byKind.get(kind) ?? 0;
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
        <div className="flex items-center gap-3 shrink-0">
          <select
            value={feedbackMode}
            disabled={savingFeedback || isBusy}
            onChange={(e) => onFeedbackModeChange(Number(e.target.value) as FeedbackMode)}
            className="text-sm rounded-lg border border-input bg-background px-3 py-2 text-foreground disabled:opacity-50"
          >
            <option value={FeedbackMode.HIDDEN}>Phản hồi: Ẩn</option>
            <option value={FeedbackMode.AFTER_SUBMIT}>Phản hồi: Sau khi nộp</option>
            <option value={FeedbackMode.AFTER_EACH}>Phản hồi: Sau mỗi câu</option>
          </select>
          {interactionsCount > 0 && (
            <Button
              type="button"
              variant="destructive"
              disabled={isBusy}
              onClick={onDeleteAll}
              className="gap-2"
            >
              {deletingLesson ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Trash2Icon className="size-4" />
              )}
              Xóa tất cả
            </Button>
          )}
          {interactionsCount > 0 && (
            <Button
              disabled={isBusy}
              onClick={onOpenGenerate}
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
  );
}

interface GenerationStatusBannersProps {
  genState: GenPhase;
  genWarnings: string[];
  onCancel?: () => void;
  onRetry?: () => void;
  cancelling?: boolean;
  retrying?: boolean;
}

export function GenerationStatusBanners({ genState, genWarnings, onCancel, onRetry, cancelling = false, retrying = false }: GenerationStatusBannersProps) {
  const heroState =
    genState.phase === "starting" ? "starting" as const :
    genState.phase === "running"  ? "running" as const :
    genState.phase === "stale"    ? "stale" as const :
    genState.phase === "error"    ? "error" as const :
    null;

  const heroTitle =
    heroState === "starting" ? "Đang khởi động tác vụ..." :
    heroState === "running"  ? "Đang tạo bài tập" :
    heroState === "stale"    ? "Tác vụ có vẻ bị treo" :
    heroState === "error"    ? "Tác vụ thất bại" :
    "";

  const heroSubtitle =
    heroState === "stale"
      ? "Worker không phản hồi. Có thể gặp sự cố — hãy hủy và thử lại."
      : heroState === "error"
        ? (genState.phase === "error" ? genState.message : "")
        : heroState === "running" && genState.phase === "running" && genState.totalChunks > 0
          ? `Đang xử lý đoạn ${genState.chunkIndex + 1}/${genState.totalChunks}`
          : heroState === "running" && genState.phase === "running"
            ? genState.message
            : "";

  const showHero = heroState != null;
  const showElapsed = heroState === "running" || heroState === "stale";

  return (
    <>
      {showHero && (
        <WorkflowProgressHero
          state={heroState}
          title={heroTitle}
          subtitle={heroSubtitle}
          elapsedSec={0}
          showElapsed={showElapsed}
          onCancel={onCancel}
          onRetry={onRetry}
          cancelling={cancelling}
          retrying={retrying}
          testId="generation-progress"
          errorTestId="gen-error"
        >
          {heroState === "running" && genState.phase === "running" && genState.totalChunks > 0 && (
            <div className="w-full bg-primary/20 rounded-full h-2">
              <div
                className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${((genState.chunkIndex + 1) / genState.totalChunks) * 100}%` }}
              />
            </div>
          )}
        </WorkflowProgressHero>
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
    </>
  );
}

interface EmptyExerciseStateProps {
  chunksCount: number;
  onOpenGenerate: () => void;
}

export function EmptyExerciseState({ chunksCount, onOpenGenerate }: EmptyExerciseStateProps) {
  return (
    <div className="flex flex-col items-center gap-5 py-12 rounded-2xl border-2 border-dashed border-primary/20 bg-gradient-to-b from-primary/5 to-transparent">
      <div className="rounded-2xl bg-primary/10 p-5 shadow-lg shadow-primary/10">
        <SparklesIcon className="size-10 text-primary" />
      </div>
      <div className="text-center max-w-lg">
        <h3 className="text-xl font-bold">Tạo bài tập bằng AI</h3>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          Tự động tạo câu hỏi trắc nghiệm, điền đáp án, bài đọc, bài nghe cho {chunksCount} phân đoạn nội dung.
        </p>
      </div>
      <div className="flex gap-3">
        <Button
          size="lg"
          onClick={onOpenGenerate}
          className="gap-2 px-8"
          data-testid="generate-all-btn"
        >
          <SparklesIcon className="size-5" />
          Bắt đầu tạo
        </Button>
      </div>
    </div>
  );
}

export function LockedExerciseState() {
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

interface ExerciseFilterBarProps {
  chunkFilter: ChunkFilter;
  isFiltered: boolean;
  onChangeChunkFilter: (filter: ChunkFilter) => void;
  onChangeSearchQuery: (query: string) => void;
  onClear: () => void;
  searchQuery: string;
}

export function ExerciseFilterBar({
  chunkFilter,
  isFiltered,
  onChangeChunkFilter,
  onChangeSearchQuery,
  onClear,
  searchQuery,
}: ExerciseFilterBarProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-1 min-w-[200px]">
        <input
          type="search"
          placeholder="Tìm phân đoạn..."
          value={searchQuery}
          onChange={e => onChangeSearchQuery(e.target.value)}
          className="w-full text-sm rounded-xl border border-input bg-background pl-10 pr-3 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
      <select
        value={chunkFilter}
        onChange={e => onChangeChunkFilter(e.target.value as ChunkFilter)}
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
          onClick={onClear}
        >
          Xoá lọc
        </button>
      )}
    </div>
  );
}
