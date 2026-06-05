"use client";

import { useRef, useState, useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { InfoIcon, Maximize, PanelRightClose, PanelRightOpen, PlayIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import type { TranscriptSegment, TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { submitAttemptErrorMessage } from "@/interactions/_shared/connect-error-message";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { VideoPlayer } from "./video-player";
import { LessonSidebar } from "./lesson-sidebar";
import { LessonResult } from "./lesson-result";
import type { QuizResult } from "./lesson-result";
import { InteractionCheckpoint } from "./interaction-checkpoint";
import { getRenderer, extractConfig, extractLocalResponse } from "@/interactions/registry";
import type { FillBlankResponse, InteractionGrade, ListeningResponse, McqResponse, ReadingResponse } from "@/interactions/types";

const CHECKPOINT_EPSILON_SECONDS = 0.35;

interface FullscreenExtensions {
  webkitFullscreenElement?: Element;
  mozFullScreenElement?: Element;
  msFullscreenElement?: Element;
  webkitExitFullscreen?: () => void;
  webkitRequestFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
}

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenTip, setShowFullscreenTip] = useState(false);
  const [previewAttemptCount, setPreviewAttemptCount] = useState(1);
  const [playerKey, setPlayerKey] = useState(0);

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
  const [savingResponseId, setSavingResponseId] = useState<string | null>(null);

  useEffect(() => {
    setLessonInteractions(interactions);
  }, [interactions]);

  // Track if sidebar is open
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem("dyadia_student_sidebar_open");
    if (saved !== null) {
      setSidebarOpen(saved === "true");
    }
  }, []);

  const handleToggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem("dyadia_student_sidebar_open", String(open));
  };

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
        setActiveId(hit.id);
      }
    },
    [submitted, activeId, pendingCheckpoints, initialPosition],
  );

  const handleFirstPlay = useCallback(() => {
    isInitialLoadRef.current = false;
    prevTimeRef.current = videoRef.current?.currentTime ?? 0;
    // Unlock interactions with startSeconds <= 0 immediately on first play
    const earlyIds = lessonInteractions.filter((it) => it.startSeconds <= 0).map((it) => it.id);
    if (earlyIds.length > 0) {
      setPassedIds((prev) => new Set([...prev, ...earlyIds]));
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
    const clampInterval = window.setInterval(clampSeek, 250);
    return () => {
      video.removeEventListener("timeupdate", clampSeek);
      video.removeEventListener("seeking", clampSeek);
      video.removeEventListener("seeked", clampSeek);
      window.clearInterval(clampInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const isNativeVideoFullscreen = () => {
    const video = videoRef.current;
    if (!video) return false;
    const docExt = document as Document & FullscreenExtensions;
    const vidExt = video as HTMLVideoElement & FullscreenExtensions;
    return (
      document.fullscreenElement === video ||
      docExt.webkitFullscreenElement === video ||
      docExt.mozFullScreenElement === video ||
      docExt.msFullscreenElement === video ||
      vidExt.webkitDisplayingFullscreen === true
    );
  };

  const exitNativeVideoFullscreen = () => {
    const video = videoRef.current;
    if (!video) return;
    const vidExt = video as HTMLVideoElement & FullscreenExtensions;
    const docExt = document as Document & FullscreenExtensions;
    try {
      if (typeof vidExt.webkitExitFullscreen === "function") {
        vidExt.webkitExitFullscreen();
      } else if (typeof document.exitFullscreen === "function") {
        document.exitFullscreen();
      } else if (typeof docExt.webkitExitFullscreen === "function") {
        docExt.webkitExitFullscreen();
      }
    } catch {}
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const docExt = document as Document & FullscreenExtensions;
    const contExt = container as HTMLDivElement & FullscreenExtensions;
    if (!document.fullscreenElement && !docExt.webkitFullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (contExt.webkitRequestFullscreen) {
        contExt.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (docExt.webkitExitFullscreen) {
        docExt.webkitExitFullscreen();
      }
    }
  };

  // Redirect native video-only fullscreen to premium container-level fullscreen automatically
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleNativeFullscreenRedirect = () => {
      if (isNativeVideoFullscreen()) {
        exitNativeVideoFullscreen();
        if (!isFullscreen) {
          setShowFullscreenTip(true);
        }
      }
    };

    const handleWebkitBeginFullscreen = (e: Event) => {
      e.preventDefault();
      exitNativeVideoFullscreen();
      if (!isFullscreen) {
        setShowFullscreenTip(true);
      }
    };

    document.addEventListener("fullscreenchange", handleNativeFullscreenRedirect);
    document.addEventListener("webkitfullscreenchange", handleNativeFullscreenRedirect);
    document.addEventListener("mozfullscreenchange", handleNativeFullscreenRedirect);
    document.addEventListener("MSFullscreenChange", handleNativeFullscreenRedirect);
    video.addEventListener("webkitbeginfullscreen", handleWebkitBeginFullscreen);

    return () => {
      document.removeEventListener("fullscreenchange", handleNativeFullscreenRedirect);
      document.removeEventListener("webkitfullscreenchange", handleNativeFullscreenRedirect);
      document.removeEventListener("mozfullscreenchange", handleNativeFullscreenRedirect);
      document.removeEventListener("MSFullscreenChange", handleNativeFullscreenRedirect);
      video.removeEventListener("webkitbeginfullscreen", handleWebkitBeginFullscreen);
    };
  }, [videoRef, isFullscreen]);

  // Exit native video fullscreen programmatically when a checkpoint triggers
  useEffect(() => {
    if (activeId && isNativeVideoFullscreen()) {
      exitNativeVideoFullscreen();
    }
  }, [activeId]);

  // Double click listener on the video element to toggle container fullscreen
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleDblClick = (e: MouseEvent) => {
      e.preventDefault();
      toggleFullscreen();
    };

    video.addEventListener("dblclick", handleDblClick);
    return () => {
      video.removeEventListener("dblclick", handleDblClick);
    };
  }, [videoRef]);

  // Keydown shortcut "F" / "f" to toggle container fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        const active = document.activeElement;
        if (
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.hasAttribute("contenteditable"))
        ) {
          return;
        }
        e.preventDefault();
        toggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Synchronize isFullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
    };
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleAnswer(id: string, response: any) {
    setResponses((prev) => new Map(prev).set(id, response));
  }

  function buildAttemptResponseInput(it: LessonInteraction, localResp: unknown) {
    if (it.kind === InteractionKind.MULTIPLE_CHOICE) {
      return {
        interactionId: it.id,
        response: {
          case: "mcqMultiple" as const,
          value: { selectedIndexes: (localResp as McqResponse | undefined)?.selectedIndexes ?? [] },
        },
      };
    }
    switch (it.config.case) {
      case "fillBlank":
        return {
          interactionId: it.id,
          response: {
            case: "fillBlank" as const,
            value: { answers: (localResp as FillBlankResponse | undefined)?.answers ?? [] },
          },
        };
      case "reading":
        return {
          interactionId: it.id,
          response: {
            case: "reading" as const,
            value: { audioObjectKey: (localResp as ReadingResponse | undefined)?.audioObjectKey ?? "" },
          },
        };
      case "listening": {
        const r = localResp as ListeningResponse | undefined;
        return {
          interactionId: it.id,
          response: {
            case: "listening" as const,
            value: {
              transcription: r?.transcription ?? "",
              comprehensionAnswers: r?.comprehensionAnswers ?? [],
            },
          },
        };
      }
      default:
        return {
          interactionId: it.id,
          response: {
            case: "mcqSelected" as const,
            value: (localResp as McqResponse | undefined)?.selected ?? 0,
          },
        };
    }
  }

  async function saveDraftResponse(id: string) {
    if (isPreview) return;
    const interaction = lessonInteractions.find((it) => it.id === id);
    if (!interaction) return;
    // Reading AFTER_EACH already calls PreviewGrade as soon as the recording is ready.
    if (interaction.kind === InteractionKind.READING && feedbackMode === FeedbackMode.AFTER_EACH) return;

    const response = buildAttemptResponseInput(interaction, responses.get(id));
    try {
      setSavingResponseId(id);
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
      setSavingResponseId((current) => (current === id ? null : current));
    }
  }

  async function handleContinue(id: string) {
    if (savingResponseId) return;
    await saveDraftResponse(id);
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
      setActiveId(nextInCheckpoint.id);
    } else {
      setActiveId(null);
      videoRef.current?.play().catch(() => {});
    }
  }

  function handleRetake() {
    prevTimeRef.current = 0;
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
  }

  function handleSubmit() {
    if (!allAnswered || submitted || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        if (isPreview) {
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
        } else {
          const protoResponses = lessonInteractions.map((it) => buildAttemptResponseInput(it, responses.get(it.id)));
          const res = await interactionClient.submitAttempt({ lessonId, responses: protoResponses });
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
            <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-white select-none">
              <div className="max-w-md flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-200">
                <div className="size-14 rounded-full bg-amber-500/10 flex items-center justify-center border border-amber-500/20 text-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.1)]">
                  <Maximize className="size-6 animate-pulse" />
                </div>
                <h3 className="text-lg font-semibold tracking-tight text-white">Bật Toàn Màn Hình Có Bài Tập</h3>
                <p className="text-sm text-zinc-300 leading-relaxed px-4">
                  Để làm được các câu hỏi tương tác trong lúc xem video, bạn hãy sử dụng tính năng <strong>Toàn màn hình chuẩn</strong> của trình phát.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 mt-4 w-full px-8">
                  <Button
                    onClick={() => {
                      setShowFullscreenTip(false);
                      toggleFullscreen();
                    }}
                    className="flex-1 bg-white hover:bg-zinc-200 text-black font-semibold rounded-full py-5 shadow-sm transition-all duration-200"
                  >
                    Bật ngay
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setShowFullscreenTip(false)}
                    className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 rounded-full py-5 transition-all duration-200"
                  >
                    Để sau
                  </Button>
                </div>
              </div>
            </div>
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
                  />
                  {savingResponseId === activeInteraction.id && (
                    <p className="mt-3 text-xs text-muted-foreground">Đang lưu câu trả lời...</p>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* State machine card */}
        {lessonInteractions.length > 0 && ((!submitted && !activeInteraction) || readyToSubmit || (submitted && result) || error) && (
          <div className="rounded-md border p-4 flex flex-col gap-3">
            {/* Not started — idle tip */}
            {!submitted && !activeInteraction && passedIds.size === 0 && (
              <div className="rounded-md bg-muted/30 p-6 text-center">
                <InfoIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="mb-1 text-base font-medium">Bài học có {lessonInteractions.length} câu hỏi tương tác</p>
                <p className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                  Video sẽ tạm dừng tại mỗi mốc để bạn trả lời. Bấm <PlayIcon className="size-3.5" /> để bắt đầu.
                </p>
              </div>
            )}

            {/* In progress */}
            {!submitted && !activeInteraction && passedIds.size > 0 && !allAnswered && (
              <p className="text-sm text-muted-foreground">
                Đã trả lời {passedIds.size}/{lessonInteractions.length} câu — tiếp tục xem video.
              </p>
            )}

            {/* Ready to submit */}
            {readyToSubmit && !activeInteraction && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Đã trả lời đủ {lessonInteractions.length}/{lessonInteractions.length} câu. Sẵn sàng nộp bài!
                </p>
                <Button
                  size="sm"
                  className="self-start gap-2"
                  disabled={isPending}
                  onClick={handleSubmit}
                >
                  <SendIcon className="size-4" />
                  {isPending ? "Đang nộp…" : "Nộp bài"}
                </Button>
              </div>
            )}

            {/* Submitted — show result */}
            {submitted && result && (
              <LessonResult
                result={result}
                interactions={lessonInteractions}
                feedbackMode={feedbackMode}
                onRetake={handleRetake}
                token={token}
                maxAttempts={maxAttempts}
              />
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
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
