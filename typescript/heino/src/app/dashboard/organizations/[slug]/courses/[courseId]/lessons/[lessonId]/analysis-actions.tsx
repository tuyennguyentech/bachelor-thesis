"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { WorkflowActionPanel } from "./analysis-workflow-ui";
import type { GenRunState } from "./use-lesson-analysis-state";

// ── Settings bar (language, max attempts) ──────────────────────────────────
// Shown above the stepper when a video is uploaded. The actual persistence
// is handled by the server actions wired up in `use-lesson-analysis-state`.

export interface LessonSettingsBarProps {
  videoStorageKey?: string;
  language: string;
  onLanguageChange: (lang: string) => void;
  savingLanguage: boolean;
  maxAttempts: number;
  onMaxAttemptsChange: (n: number) => void;
  savingMaxAttempts: boolean;
}

export function LessonSettingsBar({
  videoStorageKey,
  language,
  onLanguageChange,
  savingLanguage,
  maxAttempts,
  onMaxAttemptsChange,
  savingMaxAttempts,
}: LessonSettingsBarProps) {
  if (!videoStorageKey) return null;
  return (
    <div className="flex flex-wrap items-center gap-4 border-b pb-3 mb-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground shrink-0 font-medium">Ngôn ngữ bài giảng:</span>
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
          disabled={savingLanguage}
          className="text-xs rounded border border-input bg-background px-2 py-1 focus:ring-1 focus:ring-primary focus:outline-none"
        >
          <option value="vi">🇻🇳 Tiếng Việt</option>
          <option value="en">🇬🇧 English</option>
        </select>
        {savingLanguage && <span className="text-[10px] text-muted-foreground animate-pulse">Đang lưu...</span>}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground shrink-0 font-medium">Số lượt nộp tối đa:</span>
        <input
          type="number"
          min="0"
          value={maxAttempts}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            onMaxAttemptsChange(Number.isNaN(val) ? 0 : val);
          }}
          disabled={savingMaxAttempts}
          className="text-xs w-16 rounded border border-input bg-background px-2 py-1 text-center focus:ring-1 focus:ring-primary focus:outline-none"
        />
        <span className="text-[10px] text-muted-foreground">(0 = không giới hạn)</span>
        {savingMaxAttempts && <span className="text-[10px] text-muted-foreground animate-pulse">Đang lưu...</span>}
      </div>
    </div>
  );
}

// ── Workflow "next action" panel ────────────────────────────────────────────
// Decides which CTA to surface given the current workflow state. The order
// of the cascade is intentional: errors win over running states, which win
// over "ready to do something" hints.

export interface WorkflowNextActionProps {
  videoStorageKey?: string;
  hasTranscriptContent: boolean;
  hasChunks: boolean;
  questionsGenerated: boolean;
  chunksCount: number;
  extractPhase: string;
  chunkPhase: string;
  genState: GenRunState;
  isExtracting: boolean;
  isSyncing: boolean;
  isChunking: boolean;
  isChunkSyncing: boolean;
  isGenerating: boolean;
  activeStep: string;
  onStartExtract: () => void;
  onStartChunk: () => void;
  onOpenExercises: () => void;
  onGotoStep: (step: "upload" | "transcript" | "chunks" | "exercises") => void;
}

export function WorkflowNextAction(props: WorkflowNextActionProps) {
  const router = useRouter();
  const {
    videoStorageKey,
    hasTranscriptContent,
    hasChunks,
    questionsGenerated,
    chunksCount,
    extractPhase,
    chunkPhase,
    genState,
    isExtracting,
    isSyncing,
    isChunking,
    isChunkSyncing,
    isGenerating,
    activeStep,
    onStartExtract,
    onStartChunk,
    onOpenExercises,
    onGotoStep,
  } = props;

  const hasError = extractPhase === "error" || chunkPhase === "error" || genState.phase === "error";
  const isRunning = isExtracting || isSyncing || isChunking || isChunkSyncing || isGenerating;

  let action;
  if (hasError) {
    if (extractPhase === "error") {
      action = {
        title: "Không thể phiên âm video",
        description: "Hãy thử lại hoặc kiểm tra video có âm thanh rõ ràng.",
        primaryLabel: "Thử lại",
        onPrimary: onStartExtract,
        secondaryLabel: "Mở phiên âm",
        onSecondary: () => onGotoStep("transcript"),
        tone: "error" as const,
      };
    } else if (chunkPhase === "error") {
      action = {
        title: "Không thể phân đoạn bài học",
        description: "Transcript đã có, nhưng bước chia nội dung gặp lỗi. Bạn có thể thử phân đoạn lại.",
        primaryLabel: hasChunks ? "Phân đoạn lại" : "Phân đoạn bài học",
        onPrimary: () => { onGotoStep("chunks"); onStartChunk(); },
        secondaryLabel: "Mở phân đoạn",
        onSecondary: () => onGotoStep("chunks"),
        tone: "error" as const,
      };
    } else {
      action = {
        title: "Không thể tạo bài tập",
        description: "Bước tạo bài tập gặp lỗi. Mở phần bài tập để kiểm tra cấu hình và thử lại.",
        primaryLabel: "Mở bài tập",
        onPrimary: () => onGotoStep("exercises"),
        tone: "error" as const,
      };
    }
  } else if (isRunning) {
    if (isExtracting || isSyncing) {
      action = {
        title: "Đang trích xuất transcript",
        description: "Hệ thống đang xử lý video để tạo transcript.",
        primaryLabel: "Đang trích xuất...",
        onPrimary: () => onGotoStep("transcript"),
        primaryDisabled: true,
        tone: "default" as const,
      };
    } else if (isChunking || isChunkSyncing) {
      action = {
        title: "Đang phân đoạn bài học",
        description: "Hệ thống đang chia transcript thành các đoạn học tập có ngữ cảnh rõ ràng.",
        primaryLabel: "Đang phân đoạn...",
        onPrimary: () => onGotoStep("chunks"),
        primaryDisabled: true,
        tone: "default" as const,
      };
    } else {
      action = {
        title: "Đang tạo bài tập",
        description: "Hệ thống đang tạo câu hỏi từ các phân đoạn của bài học.",
        primaryLabel: "Đang tạo...",
        onPrimary: () => onGotoStep("exercises"),
        primaryDisabled: true,
        tone: "default" as const,
      };
    }
  } else {
    if (!videoStorageKey) {
      action = {
        title: "Tiếp theo: Tải video bài giảng",
        description: "Cần có video trước khi phiên âm, phân đoạn và tạo bài tập.",
        primaryLabel: "Mở bước tải video",
        onPrimary: () => onGotoStep("upload"),
        tone: "default" as const,
      };
    } else if (!hasTranscriptContent) {
      action = {
        title: "Tiếp theo: Trích xuất transcript",
        description: "Hệ thống sẽ xử lý video để tạo transcript.",
        primaryLabel: "Trích xuất transcript",
        onPrimary: onStartExtract,
        tone: "default" as const,
      };
    } else if (!hasChunks) {
      action = {
        title: "Tiếp theo: Phân đoạn bài học",
        description: "Transcript đã sẵn sàng. Chia bài học thành các đoạn nhỏ để tạo bài tập đúng ngữ cảnh.",
        primaryLabel: "Phân đoạn bài học",
        onPrimary: () => { onGotoStep("chunks"); onStartChunk(); },
        secondaryLabel: "Xem transcript",
        onSecondary: () => onGotoStep("transcript"),
        tone: "default" as const,
      };
    } else if (!questionsGenerated) {
      action = {
        title: "Tiếp theo: Tạo bài tập",
        description: `Đã có ${chunksCount} phân đoạn. Chọn số lượng từng loại câu hỏi rồi tạo bài tập.`,
        primaryLabel: "Tạo bài tập",
        onPrimary: () => { onGotoStep("exercises"); onOpenExercises(); },
        secondaryLabel: "Chỉnh phân đoạn",
        onSecondary: () => onGotoStep("chunks"),
        tone: "default" as const,
      };
    } else {
      action = {
        title: "Đã sẵn sàng dùng thử",
        description: "Video, transcript, phân đoạn và bài tập đã được tạo. Bạn có thể xem thử với vai trò học viên.",
        primaryLabel: "Xem thử",
        onPrimary: () => router.push("?preview=1"),
        secondaryLabel: "Tạo thêm bài tập",
        onSecondary: () => { onGotoStep("exercises"); onOpenExercises(); },
        tone: "success" as const,
      };
    }
  }


  // The "running" panels ("Đang trích xuất...", "Đang phân đoạn...",
  // "Đang tạo...") are redundant with the bottom ExtractProgressCard /
  // ChunkProgressCard / TabExercises when the user is already on the
  // matching step — they would only navigate to the step the user is
  // already viewing. Hide them in that case; keep them visible on
  // other steps as a "go to running step" prompt.
  const runningActionStep: "transcript" | "chunks" | "exercises" | null =
    isExtracting || isSyncing ? "transcript" :
    isChunking || isChunkSyncing ? "chunks" :
    isGenerating ? "exercises" :
    null;

  // Suppress the panel when the user is on the upload step (no video yet)
  // or on the exercises step with a running generate — the inline UI is
  // the primary affordance in those cases.
  const shouldHide =
    (activeStep === "upload" && !videoStorageKey) ||
    (activeStep === "exercises" && hasChunks && genState.phase !== "error" && !isGenerating && !questionsGenerated) ||
    (runningActionStep !== null && activeStep === runningActionStep);

  if (shouldHide) return null;
  return <WorkflowActionPanel {...action} />;
}
