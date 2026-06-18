"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { FileTextIcon, ListTreeIcon, SparklesIcon, VideoIcon, EyeIcon, ChevronDownIcon, ChevronUpIcon, SlidersHorizontalIcon, AlertCircleIcon, Loader2Icon } from "lucide-react";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import {
  VideoProcessingStepper,
  WorkflowStepPanel,
  type WorkflowContentStepKey,
  type WorkflowStatus,
  type WorkflowStepKey,
} from "./analysis-workflow-ui";
import { LessonTaskPanel } from "./lesson-task-panel";
import { TabExercises } from "./tab-exercises";
import { VideoUpload } from "./video-upload";
import type { PanelStep } from "./lesson-task-panel";
import {
  ChunkEditorSection,
  ChunkLockedState,
  ChunkProgressCard,
  ChunkReadyState,
  ExtractProgressCard,
  TranscriptEditorSection,
  TranscriptLockedState,
  TranscriptReadyState,
} from "./analysis-progress-card";
import { WorkflowNextAction } from "./analysis-actions";
import type { GenRunState } from "./use-lesson-analysis-state";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import type { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { LessonTaskKind, type ChunkInteractionConfig, type TranscriptChunk, type TranscriptSegment, type LessonTask } from "buf/gen/richter/v1/ai_pb";
import type { StreamRunState } from "./analysis-workflow-ui";
import type { AIClient } from "./use-lesson-analysis-state";
import { isLessonTaskActive } from "./use-lesson-tasks";

// ── Step meta ──────────────────────────────────────────────────────────────

// Narrow a workflow content step to the steps whose corresponding task
// is displayed by the bottom card. "upload" has no matching task.
function taskStepToPanelStep(step: WorkflowContentStepKey): PanelStep {
  switch (step) {
    case "transcript":
    case "chunks":
    case "exercises":
      return step;
    default:
      return null;
  }
}

function buildStepMeta(args: {
  activeStep: WorkflowContentStepKey;
  videoStorageKey?: string;
  hasSegments: boolean;
  hasChunks: boolean;
  questionsGenerated: boolean;
}): { stepNumber: number; title: string; description: string } {
  const { activeStep, videoStorageKey, hasSegments, hasChunks, questionsGenerated } = args;
  switch (activeStep) {
    case "upload":
      return {
        stepNumber: 1,
        title: "Tải video bài giảng",
        description: videoStorageKey
          ? "Video bài giảng đã được tải lên thành công. Nhấn Tiếp tục để qua bước Phiên âm."
          : "Vui lòng kéo thả hoặc chọn tệp video từ máy tính của bạn để bắt đầu bài giảng.",
      };
    case "transcript":
      return {
        stepNumber: 2,
        title: "Phiên âm bài giảng",
        description: hasSegments
          ? "Kiểm tra và chỉnh transcript trước khi phân đoạn bài học."
          : "Tạo transcript từ âm thanh video để làm dữ liệu cho các bước tiếp theo.",
      };
    case "chunks":
      return {
        stepNumber: 3,
        title: "Phân đoạn bài học",
        description: hasChunks
          ? "Rà soát mốc thời gian và chỉnh các đoạn nội dung trước khi tạo bài tập."
          : "Chia transcript thành các đoạn học tập có ngữ cảnh rõ ràng.",
      };
    case "exercises":
      return {
        stepNumber: 4,
        title: "Tạo bài tập",
        description: questionsGenerated
          ? "Quản lý, chỉnh sửa hoặc tạo thêm bài tập từ các phân đoạn đã có."
          : "Chọn cấu hình câu hỏi và tạo bài tập cho học viên.",
      };
  }
}

// ── Public shell ───────────────────────────────────────────────────────────

export interface AnalysisWorkflowShellProps {
  // Identity
  lessonId: string;
  token: string;
  videoStorageKey?: string;
  moduleId: string;
  courseId: string;
  slug: string;

  // Stepper
  activeStep: WorkflowContentStepKey;
  onGotoStep: (step: WorkflowContentStepKey) => void;
  onOpenExercises: () => void;

  // Data
  segments: TranscriptSegment[];
  chunks: TranscriptChunk[];
  interactions: LessonInteraction[];
  onInteractionsChange: (i: LessonInteraction[]) => void;
  initialDefaultInteractionConfig?: ChunkInteractionConfig;

  // Run states
  extractState: StreamRunState;
  chunkState: StreamRunState;
  genState: GenRunState;
  extractTimings: Partial<Record<number, { start: number; end?: number }>>;
  chunkTimings: Partial<Record<number, { start: number; end?: number }>>;
  now: number;

  // Tasks
  lessonTasks: LessonTask[];
  connectionError: string | null;
  onRefreshTasks: () => void;
  onCancelTask: (taskId: string) => void;

  // Settings
  feedbackMode: FeedbackMode;
  savingFeedback: boolean;
  onFeedbackModeChange: (mode: FeedbackMode) => void;

  // UI flags
  confirmReExtract: boolean;
  onConfirmReExtract: () => void;
  onCancelConfirm: () => void;
  mutatingChunkId: string | null;
  mutatingOp: "merge" | "delete" | "split" | "move" | null;
  mutatingError: string | null;
  isReloadingChunks: boolean;

  // Derived
  hasSegments: boolean;
  hasChunks: boolean;
  hasTranscriptContent: boolean;
  questionsGenerated: boolean;
  isExtracting: boolean;
  isSyncing: boolean;
  isChunking: boolean;
  isChunkSyncing: boolean;
  isGenerating: boolean;
  isBusy: boolean;

  // Pipeline statuses
  step3Status: import("./analysis-workflow-ui").PipelineStepStatus;
  step5Status: import("./analysis-workflow-ui").PipelineStepStatus;

  // Handlers
  onStartExtract: () => void;
  onStartChunk: () => void;
  onGenerate: (force?: boolean, chunkId?: string, difficulty?: string, focusPrompt?: string) => void;
  onMergeWithPrev: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDeleteChunk: (id: string) => void;
  onSplitChunk: (id: string, splitAtSeconds: number) => void;
  onMoveSegment: (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) => void;
  onSegmentUpdated: (index: number, text: string) => void;
  onSegmentSaved: () => void;

  globalDifficulty: string;
  setGlobalDifficulty: React.Dispatch<React.SetStateAction<string>>;
  globalFocusPrompt: string;
  setGlobalFocusPrompt: React.Dispatch<React.SetStateAction<string>>;
  globalKinds: import("buf/gen/richter/v1/interactions_pb").InteractionKind[];
  setGlobalKinds: React.Dispatch<React.SetStateAction<import("buf/gen/richter/v1/interactions_pb").InteractionKind[]>>;

  exerciseOpenRequest: number;
  genWarnings: string[];

  aiClient: AIClient;
}

function AIConfigPanel({
  difficulty,
  onDifficultyChange,
  focusPrompt,
  onFocusPromptChange,
  selectedKinds,
  onSelectedKindsChange,
}: {
  difficulty: string;
  onDifficultyChange: (val: string) => void;
  focusPrompt: string;
  onFocusPromptChange: (val: string) => void;
  selectedKinds: InteractionKind[];
  onSelectedKindsChange: (val: InteractionKind[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const difficultyOptions = [
    { value: "easy", label: "Dễ", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
    { value: "medium", label: "Vừa", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-300" },
    { value: "hard", label: "Khó", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  ];

  const kindOptions = [
    { kind: InteractionKind.SINGLE_CHOICE, label: "Trắc nghiệm MCQ" },
    { kind: InteractionKind.MULTIPLE_CHOICE, label: "Trắc nghiệm Multi" },
    { kind: InteractionKind.FILL_BLANK, label: "Điền vào chỗ trống" },
    { kind: InteractionKind.LISTENING, label: "Luyện nghe & Chính tả" },
    { kind: InteractionKind.READING, label: "Luyện đọc hiểu" },
  ];

  const handleKindToggle = (kind: InteractionKind) => {
    if (selectedKinds.includes(kind)) {
      if (selectedKinds.length > 1) {
        onSelectedKindsChange(selectedKinds.filter((k) => k !== kind));
      }
    } else {
      onSelectedKindsChange([...selectedKinds, kind]);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 backdrop-blur-md overflow-hidden shadow-sm transition-all duration-300">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-4 text-primary animate-pulse" />
          <span className="text-sm font-semibold text-foreground">Cấu hình AI nâng cao (Tùy chọn)</span>
        </div>
        {isOpen ? <ChevronUpIcon className="size-4 text-muted-foreground" /> : <ChevronDownIcon className="size-4 text-muted-foreground" />}
      </button>

      {isOpen && (
        <div className="border-t border-border/50 p-4 flex flex-col gap-4 bg-background/5 animate-in slide-in-from-top-1 duration-200">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Mức độ khó</label>
            <div className="flex gap-2">
              {difficultyOptions.map((opt) => {
                const active = difficulty === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onDifficultyChange(opt.value)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                      active
                        ? `${opt.cls} border-primary/50 shadow-sm ring-1 ring-primary/20`
                        : "border-border bg-transparent text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Loại câu hỏi / bài tập</label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
              {kindOptions.map((opt) => {
                const active = selectedKinds.includes(opt.kind);
                return (
                  <button
                    key={opt.kind}
                    type="button"
                    onClick={() => handleKindToggle(opt.kind)}
                    className={`flex items-center justify-center text-center p-2.5 rounded-lg border text-xs font-medium transition-all ${
                      active
                        ? "border-primary/50 bg-primary/10 text-primary shadow-sm"
                        : "border-border bg-transparent text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="workflow-focus-prompt" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Trọng tâm nội dung (Focus Prompt)
            </label>
            <textarea
              id="workflow-focus-prompt"
              rows={3}
              value={focusPrompt}
              onChange={(e) => onFocusPromptChange(e.target.value)}
              placeholder="Nhập yêu cầu định hướng cho AI (ví dụ: tập trung từ vựng IELTS chủ đề môi trường, câu hỏi phân tích...)"
              className="w-full text-xs rounded-lg border border-input bg-background/50 px-3 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function AnalysisWorkflowShell(props: AnalysisWorkflowShellProps) {
  const router = useRouter();

  // While transcription is (re)running, the transcript is being rebuilt and any
  // existing chunks/exercises are STALE (the backend only clears them after the
  // slow Whisper step finishes). So the downstream steps must NOT read "done" off
  // those stale artifacts — otherwise the UI shows "Phiên âm đang chạy" AND
  // "Bài tập: 14 câu (done)" at the same time. `transcribing` rewinds the stepper
  // to the transcript step and locks everything after it.
  const transcribing = props.isExtracting || props.isSyncing;
  // A lesson that already has generated exercises is fully processed — its earlier
  // pipeline stages must read "done" even if their intermediate artifacts (segments,
  // chunks) were never persisted or were cleared. Otherwise a lesson with exercises
  // but 0 chunks shows step 3 "not done" + step 4 "locked", which looks stuck even
  // though it's complete. `questionsGenerated` is the strongest "fully done" signal —
  // but NOT while a re-transcription is in flight (those exercises are about to be
  // regenerated).
  const isComplete = props.questionsGenerated && !transcribing;

  // Quick Create runs everything under a single RUN_PIPELINE task whose
  // progress_step is the authoritative current stage. When it's active, the
  // 5-step stepper is derived DIRECTLY from that stage — not from the artifact
  // flags below (hasChunks/questionsGenerated), which only hydrate at pipeline
  // start/end and otherwise lag the real backend stage, making the stepper
  // desync from the live progress (the bug in Image #3). This makes the stepper
  // the single, accurate progress source, replacing the separate 3-circle card.
  const pipelineTask = props.lessonTasks.find(
    (t) => t.kind === LessonTaskKind.RUN_PIPELINE && isLessonTaskActive(t),
  );
  const pipelineStage: "transcribe" | "chunk" | "generate" | null = !pipelineTask
    ? null
    : pipelineTask.progressStep.includes("GENERATING")
      ? "generate"
      : pipelineTask.progressStep.includes("CHUNKING")
        ? "chunk"
        : "transcribe";

  const uploadStatus: WorkflowStatus = !props.videoStorageKey ? "active" : "done";
  const transcriptStatus: WorkflowStatus =
    pipelineStage ? (pipelineStage === "transcribe" ? "running" : "done") :
    !props.videoStorageKey ? "locked" :
    props.extractState.phase === "error" ? "error" :
    transcribing ? "running" :
    props.hasSegments || props.hasTranscriptContent || props.hasChunks || isComplete ? "done" :
    props.activeStep === "transcript" ? "active" : "ready";
  const chunkStatus: WorkflowStatus =
    pipelineStage ? (pipelineStage === "transcribe" ? "locked" : pipelineStage === "chunk" ? "running" : "done") :
    transcribing ? "locked" :
    !props.hasTranscriptContent && !isComplete ? "locked" :
    props.chunkState.phase === "error" ? "error" :
    props.isChunking ? "running" :
    props.hasChunks || isComplete ? "done" :
    props.activeStep === "chunks" ? "active" : "ready";
  const exerciseStatus: WorkflowStatus =
    pipelineStage ? (pipelineStage === "generate" ? "running" : "locked") :
    transcribing ? "locked" :
    !props.hasChunks && !isComplete ? "locked" :
    props.genState.phase === "error" ? "error" :
    props.isGenerating ? "running" :
    props.questionsGenerated ? "done" :
    props.activeStep === "exercises" ? "active" : "ready";
  const previewStatus: WorkflowStatus =
    pipelineStage ? "locked" :
    !transcribing && (props.questionsGenerated || props.interactions.length > 0) ? "ready" : "locked";

  const segmentsCount = props.segments.length;
  const chunksCount = props.chunks.length;

  const workflowSteps: {
    key: WorkflowStepKey;
    title: string;
    subtitle: string;
    status: WorkflowStatus;
    icon: React.ReactNode;
    targetStep?: WorkflowContentStepKey;
  }[] = [
    {
      key: "upload",
      title: "Tải video",
      subtitle: props.videoStorageKey ? "Đã tải lên" : "Chờ tải video",
      status: uploadStatus,
      icon: <VideoIcon className="size-3.5" />,
      targetStep: "upload",
    },
    {
      key: "transcript",
      title: "Phiên âm",
      subtitle: props.isExtracting || props.isSyncing
        ? "Đang xử lý"
        : props.hasSegments ? `${segmentsCount} đoạn`
        : props.hasTranscriptContent ? "Đã có transcript"
        : "Sẵn sàng",
      status: transcriptStatus,
      icon: <FileTextIcon className="size-3.5" />,
      targetStep: "transcript",
    },
    {
      key: "chunks",
      title: "Phân đoạn",
      subtitle: transcribing ? "Chờ phiên âm" : props.isChunking || props.isChunkSyncing ? "Đang xử lý" : props.hasChunks ? `${chunksCount} đoạn` : props.hasTranscriptContent ? "Sẵn sàng" : "Chưa sẵn sàng",
      status: chunkStatus,
      icon: <ListTreeIcon className="size-3.5" />,
      targetStep: "chunks",
    },
    {
      key: "exercises",
      title: "Bài tập",
      subtitle: transcribing ? "Chờ phiên âm" : props.isGenerating ? "Đang tạo" : props.questionsGenerated ? `${props.interactions.length} câu` : props.hasChunks ? "Sẵn sàng" : "Chưa tạo",
      status: exerciseStatus,
      icon: <SparklesIcon className="size-3.5" />,
      targetStep: "exercises",
    },
    {
      key: "preview",
      title: "Xem thử",
      subtitle: props.questionsGenerated ? "Sẵn sàng" : "Chưa sẵn sàng",
      status: previewStatus,
      icon: <EyeIcon className="size-3.5" />,
    },
  ];

  function handleStepperSelect(step: { key: WorkflowStepKey; status: WorkflowStatus; targetStep?: WorkflowContentStepKey }) {
    if (step.status === "locked") return;
    if (step.key === "preview") {
      router.push("?preview=1");
      return;
    }
    if (step.targetStep) props.onGotoStep(step.targetStep);
  }

  // The hero card's cancel button needs the actual task id of the
  // currently running extract / chunk task. We pick the first active
  // task whose kind matches; if none, the cancel button is hidden
  // (the hero still shows the spinner + elapsed + sub-step strip).
  const activeExtractTask = props.lessonTasks.find(
    (t) => t.kind === LessonTaskKind.EXTRACT_TRANSCRIPT && isLessonTaskActive(t),
  );
  const activeChunkTask = props.lessonTasks.find(
    (t) => t.kind === LessonTaskKind.CHUNK_TRANSCRIPT && isLessonTaskActive(t),
  );
  const activeGenTask = props.lessonTasks.find(
    (t) => t.kind === LessonTaskKind.GENERATE_INTERACTIONS && isLessonTaskActive(t),
  );

  const stepMeta = buildStepMeta({
    activeStep: props.activeStep,
    videoStorageKey: props.videoStorageKey,
    hasSegments: props.hasSegments,
    hasChunks: props.hasChunks,
    questionsGenerated: props.questionsGenerated,
  });

  // Single explanatory line for the auto-pipeline, sourced from the SAME stage
  // as the stepper. Replaces the old redundant 3-circle PipelineAutoProgressCard
  // (which duplicated the stepper's stages) — the stepper below is the progress.
  const pipelineStageLabel =
    pipelineStage === "transcribe" ? "Đang phiên âm video…" :
    pipelineStage === "chunk" ? "Đang phân đoạn nội dung…" :
    pipelineStage === "generate" ? "Đang tạo bài tập…" : "";

  return (
    <div className="flex flex-col gap-3">
      {pipelineStage && (
        <div
          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
          data-testid="pipeline-auto-banner"
        >
          <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />
          <span className="font-medium text-foreground">Đang xử lý tự động</span>
          <span className="text-muted-foreground">— {pipelineStageLabel} Bạn không cần thao tác gì.</span>
        </div>
      )}
      <VideoProcessingStepper
        steps={workflowSteps}
        currentStep={props.activeStep}
        onSelect={handleStepperSelect}
      />
      {/* Advanced AI config (difficulty / question kinds / focus prompt) belongs
          to the GENERATE step only — it configures exercise generation, not
          transcription or chunking. Showing it on every step (it used to render
          whenever a video existed) cluttered the Phiên âm / Phân đoạn steps with
          irrelevant controls. `globalKinds` here is still the sole source of
          question kinds for the lesson-level generate (see use-lesson-analysis-
          state); TabExercises only overrides difficulty/focusPrompt via a dialog,
          so this panel does not duplicate that. */}
      {props.videoStorageKey && props.activeStep === "exercises" && (
        <AIConfigPanel
          difficulty={props.globalDifficulty}
          onDifficultyChange={props.setGlobalDifficulty}
          focusPrompt={props.globalFocusPrompt}
          onFocusPromptChange={props.setGlobalFocusPrompt}
          selectedKinds={props.globalKinds}
          onSelectedKindsChange={props.setGlobalKinds}
        />
      )}
      {props.connectionError && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span className="flex-1">{props.connectionError}</span>
          <button
            onClick={() => void props.onRefreshTasks()}
            className="text-xs underline hover:no-underline"
          >
            Thử lại
          </button>
        </div>
      )}
      <LessonTaskPanel
        tasks={props.lessonTasks}
        activeStep={taskStepToPanelStep(props.activeStep)}
        hidePipelineTask
        onRefresh={() => void props.onRefreshTasks()}
        onCancel={(taskId) => void props.onCancelTask(taskId)}
      />
      {/* During the auto-pipeline the slim banner + stepper already convey the
          live stage; the "next action" card would be a 3rd redundant loader, so
          suppress it until the user is back to the manual step-by-step flow. */}
      {!pipelineStage && (
        <WorkflowNextAction
          videoStorageKey={props.videoStorageKey}
          hasTranscriptContent={props.hasTranscriptContent}
          hasChunks={props.hasChunks}
          questionsGenerated={props.questionsGenerated}
          chunksCount={chunksCount}
          extractPhase={props.extractState.phase}
          chunkPhase={props.chunkState.phase}
          genState={props.genState}
          isExtracting={props.isExtracting}
          isSyncing={props.isSyncing}
          isChunking={props.isChunking}
          isChunkSyncing={props.isChunkSyncing}
          isGenerating={props.isGenerating}
          activeStep={props.activeStep}
          onStartExtract={props.onStartExtract}
          onStartChunk={props.onStartChunk}
          onOpenExercises={props.onOpenExercises}
          onGotoStep={props.onGotoStep}
        />
      )}
      <WorkflowStepPanel
        stepNumber={stepMeta.stepNumber}
        title={stepMeta.title}
        description={stepMeta.description}
      >
        {props.activeStep === "upload" && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">Nguồn video</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Tải lên hoặc thay thế tệp video dùng làm nguồn tạo nội dung bài học.
              </p>
            </div>
            <VideoUpload
              lessonId={props.lessonId}
              hasVideo={!!props.videoStorageKey}
              token={props.token}
            />
            {props.videoStorageKey && (
              <details className="mt-3 rounded-lg border border-border/30 bg-muted/20 px-3 py-2 text-xs text-muted-foreground/80">
                <summary className="cursor-pointer font-medium hover:text-foreground transition-colors">Chi tiết kỹ thuật</summary>
                <p className="mt-2 break-all font-mono text-[10px] bg-background/50 p-1.5 rounded border">Key: {props.videoStorageKey}</p>
              </details>
            )}
          </div>
        )}

        {props.activeStep === "transcript" && (
          <div className="flex flex-col gap-3 animate-in fade-in duration-200">
            {!props.videoStorageKey ? (
              <TranscriptLockedState />
            ) : (
              <>
                {props.hasTranscriptContent || props.extractState.phase !== "idle" || props.confirmReExtract ? (
                  <ExtractProgressCard
                    runState={props.extractState}
                    timings={props.extractTimings}
                    now={props.now}
                    hasTranscriptContent={props.hasTranscriptContent}
                    segmentsCount={segmentsCount}
                    confirmReExtract={props.confirmReExtract}
                    onConfirmReExtract={props.onConfirmReExtract}
                    onCancelConfirm={props.onCancelConfirm}
                    onStart={props.onStartExtract}
                    isBusy={props.isBusy}
                    onCancel={activeExtractTask
                      ? () => props.onCancelTask(activeExtractTask.id)
                      : undefined}
                    onRetry={activeExtractTask
                      ? () => {
                          props.onCancelTask(activeExtractTask.id);
                          setTimeout(() => props.onStartExtract(), 500);
                        }
                      : () => props.onStartExtract()}
                  />
                ) : (
                  <TranscriptReadyState />
                )}

                {props.hasSegments && (
                  <TranscriptEditorSection
                    segments={props.segments}
                    lessonId={props.lessonId}
                    isBusy={props.isBusy}
                    aiClient={props.aiClient}
                    onSegmentUpdated={props.onSegmentUpdated}
                    onSegmentSaved={props.onSegmentSaved}
                    status={props.step3Status}
                  />
                )}
              </>
            )}
          </div>
        )}

        {props.activeStep === "chunks" && (
          <div className="flex flex-col gap-3 animate-in fade-in duration-200">
            {!props.hasTranscriptContent ? (
              <ChunkLockedState />
            ) : (
              <>
                {props.hasChunks || props.chunkState.phase !== "idle" ? (
                  <ChunkProgressCard
                    runState={props.chunkState}
                    timings={props.chunkTimings}
                    now={props.now}
                    hasChunks={props.hasChunks}
                    isBusy={props.isBusy}
                    onStart={props.onStartChunk}
                    onCancel={activeChunkTask
                      ? () => props.onCancelTask(activeChunkTask.id)
                      : undefined}
                    onRetry={activeChunkTask
                      ? () => {
                          props.onCancelTask(activeChunkTask.id);
                          setTimeout(() => props.onStartChunk(), 500);
                        }
                      : () => props.onStartChunk()}
                  />
                ) : (
                  <ChunkReadyState
                    isBusy={props.isBusy}
                    onStart={props.onStartChunk}
                  />
                )}

                {props.hasChunks && (
                  <ChunkEditorSection
                    chunks={props.chunks}
                    segments={props.segments}
                    isBusy={props.isBusy}
                    isReloadingChunks={props.isReloadingChunks}
                    mutatingChunkId={props.mutatingChunkId}
                    mutatingOp={props.mutatingOp}
                    mutatingError={props.mutatingError}
                    status={props.step5Status}
                    onMergeWithPrev={props.onMergeWithPrev}
                    onMergeWithNext={props.onMergeWithNext}
                    onDelete={props.onDeleteChunk}
                    onSplit={props.onSplitChunk}
                    onMoveSegment={props.onMoveSegment}
                  />
                )}
              </>
            )}
          </div>
        )}

        {props.activeStep === "exercises" && (
          <TabExercises
            lessonId={props.lessonId}
            chunks={props.chunks}
            segments={props.segments}
            initialInteractions={props.interactions}
            defaultInteractionConfig={props.initialDefaultInteractionConfig}
            token={props.token}
            disabled={props.isBusy}
            genState={props.genState}
            genWarnings={props.genWarnings}
            questionsGenerated={props.questionsGenerated}
            feedbackMode={props.feedbackMode}
            savingFeedback={props.savingFeedback}
            openLessonGenerateRequest={props.exerciseOpenRequest}
            onFeedbackModeChange={props.onFeedbackModeChange}
            onGenerateLesson={(force, difficulty, focusPrompt) => props.onGenerate(force, undefined, difficulty, focusPrompt)}
            onGenerateChunk={(chunkId, force) => props.onGenerate(force, chunkId)}
            onInteractionsChange={props.onInteractionsChange}
            onCancel={activeGenTask
              ? () => props.onCancelTask(activeGenTask.id)
              : undefined}
            onRetry={activeGenTask
              ? () => {
                  props.onCancelTask(activeGenTask.id);
                  setTimeout(() => props.onGenerate(true), 500);
                }
              : () => props.onGenerate(true)}
          />
        )}
      </WorkflowStepPanel>
    </div>
  );
}
