"use client";

import { useRef, useState, useCallback, useEffect, useTransition } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionService } from "buf/gen/richter/v1/interactions_pb";
import type { TranscriptSegment, TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { submitAttemptErrorMessage } from "@/interactions/_shared/connect-error-message";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { VideoPlayer } from "./video-player";
import { LessonSidebar } from "./lesson-sidebar";
import { LessonResult } from "./lesson-result";
import type { QuizResult } from "./lesson-result";
import { InteractionCheckpoint } from "./interaction-checkpoint";
import { CheckpointMarkerStrip } from "./checkpoint-marker-strip";
import { getRenderer, extractConfig, extractLocalResponse } from "@/interactions/registry";
import type { FillBlankResponse, ListeningResponse, McqResponse, ReadingResponse } from "@/interactions/types";

interface Props {
  videoUrl: string;
  segments: TranscriptSegment[];
  transcript: string;
  chunks: TranscriptChunk[];
  lessonId: string;
  initialPosition: number;
  initialDuration?: number;
  token: string;
  interactions: LessonInteraction[];
  previousResult: QuizResult | null;
  feedbackMode: FeedbackMode;
  isPreview: boolean;
}

type MarkerStatus = "pending" | "active" | "passed";

interface Marker {
  id: string;
  index: number;
  startSeconds: number;
  status: MarkerStatus;
}

export function StudentLessonView({
  videoUrl,
  segments,
  transcript,
  chunks,
  lessonId,
  initialPosition,
  initialDuration = 0,
  token,
  interactions,
  previousResult,
  feedbackMode,
  isPreview,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const interactionClient = useRichterWebClient(InteractionService, token);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(initialDuration);

  const [submitted, setSubmitted] = useState(previousResult !== null);
  const [result, setResult] = useState<QuizResult | null>(previousResult);

  // Track answered interaction IDs and their local responses
  const [passedIds, setPassedIds] = useState<Set<string>>(
    () => previousResult !== null ? new Set(interactions.map((it) => it.id)) : new Set(),
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

  const allAnswered = interactions.length > 0 && passedIds.size >= interactions.length;
  const readyToSubmit = allAnswered && !submitted;

  // Build checkpoint markers for the strip — one marker per unique
  // start_seconds (a "cluster"), not one per interaction. Multiple
  // interactions sharing a timestamp would otherwise pile up as overlapping
  // dots and the count would mislead students about how many checkpoints
  // exist along the timeline.
  const clustersByTime = new Map<number, typeof interactions>();
  for (const it of interactions) {
    if (it.startSeconds <= 0) continue;
    const arr = clustersByTime.get(it.startSeconds) ?? [];
    arr.push(it);
    clustersByTime.set(it.startSeconds, arr);
  }
  const sortedClusters = [...clustersByTime.entries()].sort(([a], [b]) => a - b);
  const markers: Marker[] = sortedClusters.map(([startSeconds, group], i) => {
    const isActive = group.some((it) => it.id === activeId);
    const allPassed = group.every((it) => passedIds.has(it.id));
    return {
      id: `cluster-${startSeconds}`,
      index: i + 1,
      startSeconds,
      status: isActive ? "active" : allPassed ? "passed" : "pending",
    };
  });

  // The current active interaction object
  const activeInteraction = activeId
    ? interactions.find((it) => it.id === activeId) ?? null
    : null;

  // Pending checkpoints (not yet passed) ordered by startSeconds
  const pendingCheckpoints = interactions
    .filter((it) => it.startSeconds > 0 && !passedIds.has(it.id))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const handleTimeUpdate = useCallback(
    (t: number) => {
      if (submitted || activeId) return;
      const hit = pendingCheckpoints.find((c) => t >= c.startSeconds);
      if (hit) {
        videoRef.current?.pause();
        setActiveId(hit.id);
      }
    },
    [submitted, activeId, pendingCheckpoints],
  );

  const handleFirstPlay = useCallback(() => {
    // Unlock interactions with startSeconds <= 0 immediately on first play
    const earlyIds = interactions.filter((it) => it.startSeconds <= 0).map((it) => it.id);
    if (earlyIds.length > 0) {
      setPassedIds((prev) => new Set([...prev, ...earlyIds]));
    }
  }, [interactions]);

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
    const interaction = interactions.find((it) => it.id === activeId);
    if (!interaction || interaction.startSeconds <= 0) return;
    const cap = interaction.startSeconds + 5;
    const onTimeUpdate = () => {
      if (video.currentTime > cap) video.currentTime = interaction.startSeconds;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleAnswer(id: string, response: any) {
    setResponses((prev) => new Map(prev).set(id, response));
  }

  function handleContinue(id: string) {
    // Find the next pending timed interaction at the SAME timestamp (or an earlier one
    // missed somehow). Untimed (startSeconds <= 0) interactions are skipped — those are
    // auto-passed on first play and never part of a checkpoint cluster.
    const current = interactions.find((it) => it.id === id);
    const nextInCheckpoint = current
      ? interactions
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
      videoRef.current?.play();
    }
  }

  function handleSeek(seconds: number) {
    if (videoRef.current) videoRef.current.currentTime = seconds;
  }

  function handleRetake() {
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
          const respList = interactions.map((it) => {
            const localResp = responses.get(it.id) ?? null;
            const config = extractConfig(it);
            let score = 0, maxScore = 1;
            if (config && localResp) {
              try {
                const renderer = getRenderer(it.kind);
                if (renderer.gradeLocal) {
                  const g = renderer.gradeLocal(config, localResp);
                  score = g.score;
                  maxScore = g.maxScore;
                }
              } catch { /* unsupported kind */ }
            }
            return { interactionId: it.id, response: localResp, score, maxScore };
          });
          setResult({
            totalScore: respList.reduce((acc, r) => acc + r.score, 0),
            maxScore: respList.reduce((acc, r) => acc + r.maxScore, 0),
            responses: respList,
          });
        } else {
          const protoResponses = interactions.map((it) => {
            const localResp = responses.get(it.id);
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
          });
          const res = await interactionClient.submitAttempt({ lessonId, responses: protoResponses });
          const attempt = res.attempt;
          if (attempt) {
            setResult({
              totalScore: attempt.totalScore,
              maxScore: attempt.maxScore,
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
      } catch (err) {
        setError(submitAttemptErrorMessage(err));
      }
    });
  }

  const hasSidebar = chunks.length > 0 || segments.length > 0 || !!transcript;

  return (
    <div className={hasSidebar ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6" : "flex flex-col gap-6"}>
      {/* ── Left / main column ── */}
      <div className="flex flex-col gap-3">
        <VideoPlayer
          videoRef={videoRef}
          videoUrl={videoUrl}
          segments={[]}
          transcript=""
          checkpoints={[]}
          lessonId={lessonId}
          initialPosition={initialPosition}
          token={token}
          onTimeUpdate={handleTimeUpdate}
          onFirstPlay={handleFirstPlay}
          onDurationChange={setDuration}
          showTranscript={false}
        />

        {/* Checkpoint marker strip */}
        {!submitted && interactions.length > 0 && (
          <CheckpointMarkerStrip
            markers={markers}
            duration={duration}
            onSeek={handleSeek}
          />
        )}

        {/* State machine card */}
        {interactions.length > 0 && (
          <div className="rounded-lg border p-4 flex flex-col gap-3">
            {/* Not started — idle tip */}
            {!submitted && !activeInteraction && passedIds.size === 0 && (
              <div className="rounded-lg bg-muted/30 p-6 text-center">
                <p className="text-base font-medium mb-1">💡 Bài học có {interactions.length} câu hỏi tương tác</p>
                <p className="text-sm text-muted-foreground">
                  Video sẽ tạm dừng tại mỗi mốc để bạn trả lời. Bấm ▶ để bắt đầu.
                </p>
              </div>
            )}

            {/* In progress */}
            {!submitted && !activeInteraction && passedIds.size > 0 && !allAnswered && (
              <p className="text-sm text-muted-foreground">
                Đã trả lời {passedIds.size}/{interactions.length} câu — tiếp tục xem video.
              </p>
            )}

            {/* Active checkpoint */}
            {!submitted && activeInteraction && (() => {
              // A "cluster" is all interactions sharing the same start_seconds as
              // the active one (the video paused for a batch at one timestamp).
              // We label questions by their position within this cluster — that's
              // the unit students perceive, vs a confusing "Câu 6/9" global index.
              const cluster = interactions
                .filter((it) => it.startSeconds === activeInteraction.startSeconds)
                .sort((a, b) => a.orderIndex - b.orderIndex);
              const clusterIndex = cluster.findIndex((it) => it.id === activeInteraction.id) + 1;
              return (
                <InteractionCheckpoint
                  interaction={activeInteraction}
                  index={clusterIndex}
                  total={cluster.length}
                  feedbackMode={feedbackMode}
                  initialResponse={responses.get(activeInteraction.id) ?? null}
                  locked={false}
                  onAnswer={(r) => handleAnswer(activeInteraction.id, r)}
                  onContinue={() => handleContinue(activeInteraction.id)}
                  hasNextInCheckpoint={interactions.some(
                    (it) =>
                      it.id !== activeInteraction.id &&
                      !passedIds.has(it.id) &&
                      it.startSeconds > 0 &&
                      it.startSeconds <= activeInteraction.startSeconds,
                  )}
                  token={token}
                  lessonId={lessonId}
                  isPreview={isPreview}
                />
              );
            })()}

            {/* Ready to submit */}
            {readyToSubmit && !activeInteraction && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Đã trả lời đủ {interactions.length}/{interactions.length} câu. Sẵn sàng nộp bài!
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
                interactions={interactions}
                feedbackMode={feedbackMode}
                onRetake={handleRetake}
                token={token}
              />
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </div>

      {/* ── Right sidebar ── */}
      {hasSidebar && (
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
