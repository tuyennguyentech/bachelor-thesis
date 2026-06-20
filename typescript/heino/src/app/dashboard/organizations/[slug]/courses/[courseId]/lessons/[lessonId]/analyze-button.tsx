"use client";

import { useEffect, useMemo } from "react";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import type { ChunkInteractionConfig, TranscriptChunk, TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import type { AnalysisStatus } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { AnalysisWorkflowShell } from "./analysis-workflow-shell";
import { LessonSettingsBar } from "./analysis-actions";
import { useLessonAnalysisState } from "./use-lesson-analysis-state";
import { useLessonAnalysisLive } from "./lesson-analysis-live-context";

interface Props {
  lessonId: string;
  initialChunks?: TranscriptChunk[];
  initialSegments?: TranscriptSegment[];
  initialTranscript?: string;
  initialStatus?: AnalysisStatus;
  initialErrorMsg?: string;
  initialInteractions?: LessonInteraction[];
  initialFeedbackMode?: FeedbackMode;
  initialDefaultInteractionConfig?: ChunkInteractionConfig;
  initialLanguage?: string;
  initialAudioLanguage?: string;
  initialMaxAttempts?: number;
  title: string;
  description: string;
  orderIndex: number;
  token: string;
  videoStorageKey?: string;
  moduleId: string;
  courseId: string;
  slug: string;
}

export function AnalyzeButton({
  lessonId,
  initialChunks = [],
  initialSegments = [],
  initialTranscript = "",
  initialStatus,
  initialErrorMsg,
  initialInteractions = [],
  initialFeedbackMode = FeedbackMode.AFTER_SUBMIT,
  initialDefaultInteractionConfig,
  initialLanguage = "vi",
  initialAudioLanguage = "",
  initialMaxAttempts = 0,
  title,
  description,
  orderIndex,
  token,
  videoStorageKey,
  moduleId,
  courseId,
  slug,
}: Props) {
  const aiClient = useRichterWebClient(AIService, token);
  const lessonClient = useRichterWebClient(LessonService, token);

  const state = useMemo(
    () => ({
      lessonId,
      aiClient,
      lessonClient,
      initialChunks,
      initialSegments,
      initialTranscript,
      initialStatus,
      initialErrorMsg,
      initialInteractions,
      initialFeedbackMode,
      initialLanguage,
      initialAudioLanguage,
      initialMaxAttempts,
      title,
      description,
      orderIndex,
      videoStorageKey,
    }),
    [
      lessonId, aiClient, lessonClient, initialChunks, initialSegments, initialTranscript,
      initialStatus, initialErrorMsg, initialInteractions, initialFeedbackMode,
      initialLanguage, initialAudioLanguage, initialMaxAttempts,
      title, description, orderIndex, videoStorageKey,
    ],
  );

  const s = useLessonAnalysisState(state);

  // Publish the live transcript/segments so the content tab's VideoPlayer (a
  // separate, server-rendered subtree) reflects a freshly-run transcription
  // without a router.refresh (which would re-trigger the heavy tab reload). The
  // hook tracks segments only; the plain-text transcript (a fallback for the
  // no-segments case) is derived from them.
  const publishLive = useLessonAnalysisLive()?.publish;
  const liveTranscript = useMemo(
    () => s.segments.map((seg) => seg.text).join(" "),
    [s.segments],
  );
  useEffect(() => {
    publishLive?.({ segments: s.segments, transcript: liveTranscript });
  }, [s.segments, liveTranscript, publishLive]);

  return (
    <div className="flex flex-col gap-3">
      <LessonSettingsBar
        lessonId={lessonId}
        aiClient={aiClient}
        videoStorageKey={videoStorageKey}
        language={s.language}
        onLanguageChange={s.setLanguage}
        savingLanguage={s.savingLanguage}
        audioLanguage={s.audioLanguage}
        onAudioLanguageChange={s.setAudioLanguage}
        savingAudioLanguage={s.savingAudioLanguage}
        maxAttempts={s.maxAttempts}
        onMaxAttemptsChange={s.setMaxAttempts}
        savingMaxAttempts={s.savingMaxAttempts}
      />
      <AnalysisWorkflowShell
        lessonId={lessonId}
        token={token}
        videoStorageKey={videoStorageKey}
        moduleId={moduleId}
        courseId={courseId}
        slug={slug}
        activeStep={s.activeStep}
        onGotoStep={s.setActiveStep}
        onOpenExercises={s.bumpExerciseOpenRequest}
        segments={s.segments}
        chunks={s.chunks}
        interactions={s.interactions}
        onInteractionsChange={s.setInteractions}
        initialDefaultInteractionConfig={initialDefaultInteractionConfig}
        extractState={s.extractState}
        chunkState={s.chunkState}
        genState={s.genState}
        extractTimings={s.extractTimings}
        chunkTimings={s.chunkTimings}
        now={s.now}
        lessonTasks={s.lessonTasks}
        connectionError={s.connectionError}
        onRefreshTasks={() => void s.refreshTasks()}
        onCancelTask={(taskId) => void s.cancelTask(taskId)}
        feedbackMode={s.feedbackMode}
        savingFeedback={s.savingFeedback}
        onFeedbackModeChange={s.setFeedbackMode}
        confirmReExtract={s.confirmReExtract}
        onConfirmReExtract={() => s.setConfirmReExtract(true)}
        onCancelConfirm={() => s.setConfirmReExtract(false)}
        mutatingChunkId={s.mutatingChunkId}
        mutatingOp={s.mutatingOp}
        mutatingError={s.mutatingError}
        isReloadingChunks={s.isReloadingChunks}
        hasSegments={s.hasSegments}
        hasChunks={s.hasChunks}
        hasTranscriptContent={s.hasTranscriptContent}
        questionsGenerated={s.questionsGenerated}
        isExtracting={s.isExtracting}
        isSyncing={s.isSyncingExtract}
        isChunking={s.isChunking}
        isChunkSyncing={s.isSyncingChunk}
        isGenerating={s.isGenerating}
        isBusy={s.isBusy}
        step3Status={s.step3Status}
        step5Status={s.step5Status}
        onStartExtract={s.startExtract}
        onStartChunk={s.handleChunk}
        onGenerate={s.handleGenerate}
        onMergeWithPrev={(id) => void s.handleMergeWithPrev(id)}
        onMergeWithNext={(id) => void s.handleMergeWithNext(id)}
        onDeleteChunk={(id) => void s.handleDeleteChunk(id)}
        onSplitChunk={(id, s2) => void s.handleSplitChunk(id, s2)}
        onMoveSegment={(a, b, c, d) => void s.handleMoveSegment(a, b, c, d)}
        onSegmentUpdated={(i, t) => s.setSegments((prev) => prev.map((seg, j) => j === i ? { ...seg, text: t } : seg))}
        onSegmentSaved={() => {}}
        exerciseOpenRequest={s.exerciseOpenRequest}
        genWarnings={s.genWarnings}
        aiClient={aiClient}
      />
    </div>
  );
}
