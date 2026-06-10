"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { FileTextIcon, ListTreeIcon, SparklesIcon, VideoIcon, EyeIcon } from "lucide-react";
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
  step2Status: import("./analysis-workflow-ui").PipelineStepStatus;
  step3Status: import("./analysis-workflow-ui").PipelineStepStatus;
  step4Status: import("./analysis-workflow-ui").PipelineStepStatus;
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

  exerciseOpenRequest: number;
  genWarnings: string[];

  aiClient: AIClient;
}

export function AnalysisWorkflowShell(props: AnalysisWorkflowShellProps) {
  const router = useRouter();

  const uploadStatus: WorkflowStatus = !props.videoStorageKey ? "active" : "done";
  const transcriptStatus: WorkflowStatus =
    !props.videoStorageKey ? "locked" :
    props.extractState.phase === "error" ? "error" :
    props.isExtracting ? "running" :
    props.hasSegments || props.hasTranscriptContent ? "done" :
    props.activeStep === "transcript" ? "active" : "ready";
  const chunkStatus: WorkflowStatus =
    !props.hasTranscriptContent ? "locked" :
    props.chunkState.phase === "error" ? "error" :
    props.isChunking ? "running" :
    props.hasChunks ? "done" :
    props.activeStep === "chunks" ? "active" : "ready";
  const exerciseStatus: WorkflowStatus =
    !props.hasChunks ? "locked" :
    props.genState.phase === "error" ? "error" :
    props.isGenerating ? "running" :
    props.questionsGenerated ? "done" :
    props.activeStep === "exercises" ? "active" : "ready";
  const previewStatus: WorkflowStatus = (props.questionsGenerated || props.interactions.length > 0) ? "ready" : "locked";

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
      subtitle: props.isChunking || props.isChunkSyncing ? "Đang xử lý" : props.hasChunks ? `${chunksCount} đoạn` : props.hasTranscriptContent ? "Sẵn sàng" : "Chưa sẵn sàng",
      status: chunkStatus,
      icon: <ListTreeIcon className="size-3.5" />,
      targetStep: "chunks",
    },
    {
      key: "exercises",
      title: "Bài tập",
      subtitle: props.isGenerating ? "Đang tạo" : props.questionsGenerated ? `${props.interactions.length} câu` : props.hasChunks ? "Sẵn sàng" : "Chưa tạo",
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

  const stepMeta = buildStepMeta({
    activeStep: props.activeStep,
    videoStorageKey: props.videoStorageKey,
    hasSegments: props.hasSegments,
    hasChunks: props.hasChunks,
    questionsGenerated: props.questionsGenerated,
  });

  return (
    <div className="flex flex-col gap-3">
      <VideoProcessingStepper
        steps={workflowSteps}
        currentStep={props.activeStep}
        onSelect={handleStepperSelect}
      />
      <LessonTaskPanel
        tasks={props.lessonTasks}
        activeStep={taskStepToPanelStep(props.activeStep)}
        onRefresh={() => void props.onRefreshTasks()}
        onCancel={(taskId) => void props.onCancelTask(taskId)}
      />
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
              moduleId={props.moduleId}
              courseId={props.courseId}
              slug={props.slug}
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
          />
        )}
      </WorkflowStepPanel>
    </div>
  );
}
