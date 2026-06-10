"use client";

import { useRef, useState, useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import type { TranscriptSegment, TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { submitAttemptErrorMessage } from "@/interactions/_shared/connect-error-message";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { videoPlayerConfig } from "@/lib/client-config";
import { VideoPlayer } from "./video-player";
import { LessonSidebar } from "./lesson-sidebar";
import type { QuizResult } from "./lesson-result";
import { InteractionCheckpoint } from "./interaction-checkpoint";
import { buildAttemptResponseInput } from "./student-attempt-response";
import type { PreviewMetrics } from "./lesson-result";
import { StudentFullscreenTip } from "./student-fullscreen-tip";
import { StudentLessonStatusCard } from "./student-lesson-status-card";
import { useStudentFullscreen } from "./use-student-fullscreen";
import { useStudentSidebarState } from "./use-student-sidebar-state";
import { getRenderer, extractConfig, extractLocalResponse } from "@/interactions/registry";
import type { InteractionGrade } from "@/interactions/types";

const CHECKPOINT_EPSILON_SECONDS = 0.35;

interface Props {
  videoUrl: string;
  videoStorageKey?: string;
  segments: TranscriptSegment[];
  transcript: string;
  chunks: TranscriptChunk[];
  lessonId: string;
  initialPosition: number;

  token: string;
  interactions: LessonInteraction[];
  previousResult: QuizResult | null;
  feedbackMode: FeedbackMode;
  isPreview: boolean;
  maxAttempts?: number;
}

export function StudentLessonView({
  videoUrl,
  videoStorageKey,
  segments,
  transcript,
  chunks,
  lessonId,
  initialPosition,
  token,
  interactions,
  previousResult,
  feedbackMode,
  isPreview,
  maxAttempts,
}: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevTimeRef = useRef(initialPosition);
  const isInitialLoadRef = useRef(true);
  const [previewAttemptCount, setPreviewAttemptCount] = useState(1);
  const [playerKey, setPlayerKey] = useState(0);

  // Metrics tracking refs — do NOT cause re-renders, so useRef is appropriate
  /** Timestamp (Date.now()) when each question became active (was shown to student) */
  const questionShownAtRef = useRef<Map<string, number>>(new Map());
  /** Computed time-to-answer in ms per interaction id */
  const timeToAnswerMsRef = useRef<Map<string, number>>(new Map());
  /** Replay count per listening interaction id */
  const replayCountsRef = useRef<Map<string, number>>(new Map());
  /** Furthest video position (seconds) reached — for watch fraction computation */
  const maxVideoPositionRef = useRef(initialPosition);

  const [previewMetrics, setPreviewMetrics] = useState<PreviewMetrics | null>(null);

  // Reset initial load flag when playerKey changes (on retake)
  useEffect(() => {
    isInitialLoadRef.current = true;
  }, [playerKey]);
  const interactionClient = useRichterWebClient(InteractionService, token);
  const aiClient = useRichterWebClient(AIService, token);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(previousResult !== null);
  const [result, setResult] = useState<QuizResult | null>(previousResult);
  const [lessonInteractions, setLessonInteractions] = useState(interactions);
  const [draftGrades, setDraftGrades] = useState<Map<string, InteractionGrade>>(() => new Map());
  const [savingResponseIds, setSavingResponseIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setLessonInteractions(interactions);
  }, [interactions]);

  const { handleToggleSidebar, sidebarOpen } = useStudentSidebarState();

  // Track answered interaction IDs and their local responses
  const [passedIds, setPassedIds] = useState<Set<string>>(
    () => previousResult !== null ? new Set(lessonInteractions.map((it) => it.id)) : new Set(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [responses, setResponses] = useState<Map<string, any>>(
    () => {
      if (!previousResult) return new Map();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = new Map<string, any>();
      for (const r of previousResult.responses) {
        if (r.response != null) m.set(r.interactionId, r.response);
      }
      return m;
    },
  );
  // Which checkpoint is currently active (paused on)
  const [activeId, setActiveId] = useState<string | null>(null);
  const {
    isFullscreen,
    setShowFullscreenTip,
    showFullscreenTip,
    toggleFullscreen,
  } = useStudentFullscreen({ activeId, containerRef, videoRef });

  const allAnswered = lessonInteractions.length > 0 && passedIds.size >= lessonInteractions.length;
  const readyToSubmit = allAnswered && !submitted;

  // The current active interaction object
  const activeInteraction = activeId
    ? lessonInteractions.find((it) => it.id === activeId) ?? null
    : null;

  // Pending checkpoints (not yet passed) ordered by startSeconds
  const pendingCheckpoints = lessonInteractions
    .filter((it) => it.startSeconds > 0 && !passedIds.has(it.id))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const handleTimeUpdate = useCallback(
    (t: number) => {
      // Track furthest position for video watch fraction (even while paused at checkpoint)
      if (t > maxVideoPositionRef.current) {
        maxVideoPositionRef.current = t;
      }

      if (submitted || activeId) return;

      // If the time has changed from the initial load state, clear the initial load gate
      if (isInitialLoadRef.current && Math.abs(t - initialPosition) > 1) {
        isInitialLoadRef.current = false;
      }

      // Ignore all time updates until the video has actually been played
      if (isInitialLoadRef.current) return;

      // Ignore timeupdates before the first real playback position to prevent
      // false triggers from initial buffering time jumps
      if (t < 0.5) return;

      const prev = prevTimeRef.current;
      prevTimeRef.current = t;

      const hit = pendingCheckpoints.find(
        (c) => prev < c.startSeconds && t + CHECKPOINT_EPSILON_SECONDS >= c.startSeconds,
      );
      if (hit) {
        const video = videoRef.current;
        if (video) video.pause();
        // Record when this question was shown to the student
        if (!questionShownAtRef.current.has(hit.id)) {
          questionShownAtRef.current.set(hit.id, Date.now());
        }
        setActiveId(hit.id);
      }
    },
    [submitted, activeId, pendingCheckpoints, initialPosition],
  );

  const handleFirstPlay = useCallback(() => {
    isInitialLoadRef.current = false;
    prevTimeRef.current = videoRef.current?.currentTime ?? 0;
    // Unlock interactions with startSeconds <= 0 immediately on first play
    const earlyInteractions = lessonInteractions.filter((it) => it.startSeconds <= 0);
    const now = Date.now();
    for (const it of earlyInteractions) {
      if (!questionShownAtRef.current.has(it.id)) {
        questionShownAtRef.current.set(it.id, now);
      }
    }
    if (earlyInteractions.length > 0) {
      setPassedIds((prev) => new Set([...prev, ...earlyInteractions.map((it) => it.id)]));
    }
  }, [lessonInteractions]);

  // While a checkpoint is active: prevent the student from playing the video.
  useEffect(() => {
    if (!activeId) return;
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => video.pause();
    video.addEventListener("play", onPlay);
    return () => video.removeEventListener("play", onPlay);
  }, [activeId]);

  // While a checkpoint is active: prevent seeking past the checkpoint's start time.
  useEffect(() => {
    if (!activeId) return;
    const video = videoRef.current;
    if (!video) return;
    const interaction = lessonInteractions.find((it) => it.id === activeId);
    if (!interaction || interaction.startSeconds <= 0) return;
    const cap = interaction.startSeconds + 5;
    const clampSeek = () => {
      if (video.currentTime <= cap) return;
      video.currentTime = interaction.startSeconds;
      prevTimeRef.current = interaction.startSeconds;
      video.pause();
    };
    clampSeek();
    video.addEventListener("timeupdate", clampSeek);
    video.addEventListener("seeking", clampSeek);
    video.addEventListener("seeked", clampSeek);
    const clampInterval = window.setInterval(clampSeek, videoPlayerConfig.seekClampIntervalMs);
    return () => {
      video.removeEventListener("timeupdate", clampSeek);
      video.removeEventListener("seeking", clampSeek);
      video.removeEventListener("seeked", clampSeek);
      window.clearInterval(clampInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleAnswer(id: string, response: any) {
    setResponses((prev) => new Map(prev).set(id, response));
  }

  function recordTimeToAnswer(id: string) {
    if (timeToAnswerMsRef.current.has(id)) return; // already recorded (e.g. called twice)
    const shownAt = questionShownAtRef.current.get(id);
    if (shownAt != null) {
      timeToAnswerMsRef.current.set(id, Date.now() - shownAt);
    }
  }

  async function saveDraftResponse(id: string) {
    if (isPreview) return;
    const interaction = lessonInteractions.find((it) => it.id === id);
    if (!interaction) return;
    // Reading AFTER_EACH already calls PreviewGrade as soon as the recording is ready.
    if (interaction.kind === InteractionKind.READING && feedbackMode === FeedbackMode.AFTER_EACH) return;

    const metrics = {
      timeToAnswerMs: timeToAnswerMsRef.current.get(id) ?? 0,
      replayCount: replayCountsRef.current.get(id) ?? 0,
    };
    const response = buildAttemptResponseInput(interaction, responses.get(id), metrics);
    try {
      setSavingResponseIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      const saved = await interactionClient.saveAttemptResponse({ lessonId, response });
      if (saved.feedbackRevealed) {
        setDraftGrades((prev) => new Map(prev).set(id, {
          score: saved.score,
          maxScore: saved.maxScore,
          feedback: saved.feedback,
        }));
      }
    } catch {
      // Best effort: final submit can still grade this response if the draft save failed.
      setError("Một câu trả lời chưa được lưu tạm thời. Hệ thống sẽ chấm lại khi nộp bài.");
    } finally {
      setSavingResponseIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function handleContinue(id: string) {
    if (savingResponseIds.has(id)) return;
    // Record time-to-answer before firing the async save
    recordTimeToAnswer(id);
    void saveDraftResponse(id);
    // Find the next pending timed interaction at the SAME timestamp (or an earlier one
    // missed somehow). Untimed (startSeconds <= 0) interactions are skipped — those are
    // auto-passed on first play and never part of a checkpoint cluster.
    const current = lessonInteractions.find((it) => it.id === id);
    const nextInCheckpoint = current
      ? lessonInteractions
          .filter(
            (it) =>
              it.id !== id &&
              !passedIds.has(it.id) &&
              it.startSeconds > 0 &&
              it.startSeconds <= current.startSeconds,
          )
          .sort((a, b) => a.startSeconds - b.startSeconds)[0]
      : undefined;
    setPassedIds((prev) => new Set([...prev, id]));
    if (nextInCheckpoint) {
      // Record shown time for the next question in the cluster
      if (!questionShownAtRef.current.has(nextInCheckpoint.id)) {
        questionShownAtRef.current.set(nextInCheckpoint.id, Date.now());
      }
      setActiveId(nextInCheckpoint.id);
    } else {
      setActiveId(null);
      videoRef.current?.play().catch(() => {});
    }
  }

  function handleRetake() {
    prevTimeRef.current = 0;
    maxVideoPositionRef.current = 0;
    questionShownAtRef.current = new Map();
    timeToAnswerMsRef.current = new Map();
    replayCountsRef.current = new Map();
    setPlayerKey((prev) => prev + 1);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.pause();
    }
    if (isPreview) {
      setPreviewAttemptCount((prev) => prev + 1);
    }
    setSubmitted(false);
    setResult(null);
    setPassedIds(new Set());
    setResponses(new Map());
    setActiveId(null);
    setError(null);
    setPreviewMetrics(null);
  }

  function computeVideoWatchFraction(): number {
    const video = videoRef.current;
    const duration = video?.duration ?? 0;
    if (!duration || duration <= 0) return 0;
    const fraction = maxVideoPositionRef.current / duration;
    return Math.min(1, Math.max(0, fraction));
  }

  function handleSubmit() {
    if (!allAnswered || submitted || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const videoWatchFraction = computeVideoWatchFraction();

        if (isPreview) {
          // Record any remaining TTA for interactions that may have been answered without
          // going through handleContinue (e.g. startSeconds <= 0)
          for (const it of lessonInteractions) {
            recordTimeToAnswer(it.id);
          }

          const respList = await Promise.all(lessonInteractions.map(async (it) => {
            const localResp = responses.get(it.id) ?? null;
            const config = extractConfig(it);
            let score = 0, maxScore = 1;
            const draftGrade = draftGrades.get(it.id);
            let feedback = draftGrade?.feedback;
            if (draftGrade) {
              score = draftGrade.score;
              maxScore = draftGrade.maxScore;
            } else if (it.kind === InteractionKind.READING && localResp) {
              try {
                const grade = await interactionClient.previewGrade({
                  lessonId,
                  response: buildAttemptResponseInput(it, localResp),
                });
                score = grade.score;
                maxScore = grade.maxScore;
                feedback = grade.feedback;
              } catch {
                maxScore = 1;
                feedback = "Chế độ xem thử chưa chấm tự động phần ghi âm này. Khi học viên nộp bài thật, hệ thống sẽ chấm AI và hiển thị phiên âm cùng nhận xét tại đây.";
              }
            } else if (config && localResp) {
              try {
                const renderer = getRenderer(it.kind);
                if (renderer.gradeLocal) {
                  const g = renderer.gradeLocal(config, localResp);
                  score = g.score;
                  maxScore = g.maxScore;
                }
              } catch { /* unsupported kind */ }
            }
            return { interactionId: it.id, response: localResp, score, maxScore, feedback };
          }));
          setResult({
            totalScore: respList.reduce((acc, r) => acc + r.score, 0),
            maxScore: respList.reduce((acc, r) => acc + r.maxScore, 0),
            attemptCount: previewAttemptCount,
            responses: respList,
          });
          // Build preview metrics snapshot for teacher reference
          setPreviewMetrics({
            timeToAnswerMs: new Map(timeToAnswerMsRef.current),
            replayCounts: new Map(replayCountsRef.current),
            videoWatchFraction,
          });
        } else {
          const protoResponses = lessonInteractions.map((it) => buildAttemptResponseInput(
            it,
            responses.get(it.id),
            {
              timeToAnswerMs: timeToAnswerMsRef.current.get(it.id) ?? 0,
              replayCount: replayCountsRef.current.get(it.id) ?? 0,
            },
          ));
          const res = await interactionClient.submitAttempt({
            lessonId,
            responses: protoResponses,
            videoWatchFraction,
          });
          const attempt = res.attempt;
          if (attempt) {
            const freshInteractions = await aiClient
              .getLessonAnalysis({ lessonId })
              .then((analysisResult) => analysisResult.analysis?.interactions ?? null)
              .catch(() => null);
            if (freshInteractions) {
              setLessonInteractions(freshInteractions);
            }
            setResult({
              totalScore: attempt.totalScore,
              maxScore: attempt.maxScore,
              attemptCount: attempt.attemptCount,
              responses: attempt.responses.map((r) => ({
                interactionId: r.interactionId,
                response: extractLocalResponse(r),
                score: r.score,
                maxScore: r.maxScore,
                feedback: r.feedback,
              })),
            });
          }
        }
        setSubmitted(true);
        if (!isPreview) {
          router.refresh();
        }
      } catch (err) {
        setError(submitAttemptErrorMessage(err));
      }
    });
  }

  const hasSidebar = chunks.length > 0 || segments.length > 0 || !!transcript;

  return (
    <div className={hasSidebar && sidebarOpen ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6" : "grid grid-cols-1 gap-6"}>
      {/* ── Left / main column ── */}
      <div className="flex flex-col gap-3">
        {hasSidebar && (
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Trình phát bài học</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleToggleSidebar(!sidebarOpen)}
              className="gap-2 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-all duration-200"
            >
              {sidebarOpen ? (
                <>
                  <PanelRightClose className="size-4 text-muted-foreground" />
                  <span>Thu gọn dàn bài</span>
                </>
              ) : (
                <>
                  <PanelRightOpen className="size-4 text-muted-foreground" />
                  <span>Hiển thị dàn bài</span>
                </>
              )}
            </Button>
          </div>
        )}

        <div ref={containerRef} className="relative w-full rounded-md overflow-hidden border bg-black shadow-sm group [&:fullscreen]:h-screen [&:fullscreen]:rounded-none [&:fullscreen]:border-none">
          <VideoPlayer
            playerKey={playerKey}
            videoRef={videoRef}
            videoUrl={videoUrl}
            videoStorageKey={videoStorageKey}
            lessonId={lessonId}
            initialPosition={initialPosition}
            token={token}
            onTimeUpdate={handleTimeUpdate}
            onFirstPlay={handleFirstPlay}
            showTranscript={false}
            allowNativeFullscreen={false}
            isFullscreen={isFullscreen}
            onFullscreenToggle={toggleFullscreen}
            interactions={lessonInteractions}
          />

          {/* Fullscreen Helper Tip Overlay */}
          {showFullscreenTip && (
            <StudentFullscreenTip
              onDismiss={() => setShowFullscreenTip(false)}
              onEnable={() => {
                setShowFullscreenTip(false);
                toggleFullscreen();
              }}
            />
          )}
          {!submitted && activeInteraction && (() => {
            // A "cluster" is all interactions sharing the same start_seconds as
            // the active one (the video paused for a batch at one timestamp).
            // We label questions by their position within this cluster.
            const cluster = lessonInteractions
              .filter((it) => it.startSeconds === activeInteraction.startSeconds)
              .sort((a, b) => a.orderIndex - b.orderIndex);
            const clusterIndex = cluster.findIndex((it) => it.id === activeInteraction.id) + 1;
            return (
              <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col items-center justify-center p-6 md:p-8 overflow-y-auto text-foreground animate-in fade-in duration-200">
                <div className="w-full h-full bg-card p-6 md:p-8 overflow-y-auto flex flex-col justify-between rounded-none border-none">
                  <InteractionCheckpoint
                    interaction={activeInteraction}
                    index={clusterIndex}
                    total={cluster.length}
                    feedbackMode={feedbackMode}
                    initialResponse={responses.get(activeInteraction.id) ?? null}
                    locked={submitted}
                    onAnswer={(r) => handleAnswer(activeInteraction.id, r)}
                    onContinue={() => handleContinue(activeInteraction.id)}
                    hasNextInCheckpoint={lessonInteractions.some(
                      (it) =>
                        it.id !== activeInteraction.id &&
                        !passedIds.has(it.id) &&
                        it.startSeconds > 0 &&
                        it.startSeconds <= activeInteraction.startSeconds,
                    )}
                    token={token}
                    lessonId={lessonId}
                    isPreview={isPreview}
                    onGrade={(grade) => {
                      setDraftGrades((prev) => new Map(prev).set(activeInteraction.id, grade));
                    }}
                    onReplayCount={(count) => {
                      replayCountsRef.current.set(activeInteraction.id, count);
                    }}
                  />
                  {savingResponseIds.has(activeInteraction.id) && (
                    <p className="mt-3 text-xs text-muted-foreground">Đang lưu câu trả lời...</p>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        <StudentLessonStatusCard
          activeInteraction={activeInteraction}
          error={error}
          feedbackMode={feedbackMode}
          isPending={isPending}
          lessonInteractions={lessonInteractions}
          maxAttempts={maxAttempts}
          onRetake={handleRetake}
          onSubmit={handleSubmit}
          passedCount={passedIds.size}
          readyToSubmit={readyToSubmit}
          result={result}
          submitted={submitted}
          token={token}
          previewMetrics={isPreview && previewMetrics ? previewMetrics : undefined}
        />
      </div>

      {/* ── Right sidebar ── */}
      {hasSidebar && sidebarOpen && (
        <aside className="lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <LessonSidebar
            chunks={chunks}
            segments={segments}
            transcript={transcript}
            videoRef={videoRef}
          />
        </aside>
      )}
    </div>
  );
}
