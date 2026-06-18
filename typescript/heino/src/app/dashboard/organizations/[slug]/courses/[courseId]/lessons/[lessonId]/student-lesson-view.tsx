"use client";

import { useRef, useState, useCallback, useEffect, useMemo, useTransition } from "react";
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
/** Tolerance (seconds) for the forward-seek guard. Seeking within this slack of
 *  the high-water mark is treated as a rewatch/rewind, not a forbidden skip. */
const FORWARD_SEEK_SLACK_S = 1;

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
  nextLessonHref?: string;
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
  nextLessonHref,
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
  /**
   * Accumulated ACTUAL watched time (seconds).  Only continuous forward playback
   * deltas (≤ MAX_DELTA_SECONDS) are counted.  Forward seeks (large jumps) and
   * paused intervals are excluded so seeking to the end cannot inflate the metric.
   */
  const watchedSecondsRef = useRef(0);
  /**
   * High-water mark (seconds) of the furthest position the student has legitimately
   * reached via real forward playback.  Advanced ONLY on genuine forward playback
   * (never on seeks) and used by the always-on seek guard to block fast-forward
   * while still allowing rewind / rewatch of already-seen regions.
   */
  const maxWatchedSecondsRef = useRef(initialPosition);
  // Throttled mirror of the high-water mark for the locked-region scrubber band.
  // Updated at most ~1×/s from handleTimeUpdate so the band re-renders without
  // churning on every video tick.
  const [maxWatchedSeconds, setMaxWatchedSeconds] = useState(initialPosition);
  const lastMaxWatchedPushRef = useRef(0);
  /** Maximum delta between two consecutive timeupdate events to be counted as
   *  real playback (not a seek).  HTMLVideoElement fires timeupdate ~4× per second,
   *  so legitimate playback steps are < 0.5 s; we use 1.5 s to tolerate buffering. */
  const MAX_WATCH_DELTA_SECONDS = 1.5;

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

  // ── In-progress draft persistence ──────────────────────────────────────────
  // Mirror the student's answers + passed checkpoints to sessionStorage so a
  // page refresh mid-attempt doesn't wipe their progress. (Video position
  // already persists server-side via getWatchProgress → initialPosition.)
  // Skipped in preview mode (teacher testing) and cleared once submitted.
  const draftKey = `dyadia:attempt-draft:v1:${lessonId}`;
  const draftHydratedRef = useRef(false);

  // Hydrate once on mount. Reading sessionStorage in a useState initializer would
  // diverge between SSR and the client and trigger a hydration mismatch, so we
  // restore here (client-only) after the first paint instead.
  useEffect(() => {
    draftHydratedRef.current = true;
    if (isPreview || previousResult !== null) return;
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responses?: [string, any][];
        passedIds?: string[];
      };
      if (Array.isArray(saved.responses) && saved.responses.length > 0) {
        setResponses(new Map(saved.responses));
      }
      if (Array.isArray(saved.passedIds) && saved.passedIds.length > 0) {
        setPassedIds(new Set(saved.passedIds));
      }
    } catch {
      // corrupt or unavailable storage — start fresh
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change; clear once submitted (the submit handler / "Làm lại" empty
  // the maps, but we must NOT remove on empty otherwise: on mount the hydrate
  // effect's setState hasn't applied yet, so this effect would delete the draft
  // it just restored. Writing only when there's progress, and removing only on
  // submit, avoids that destructive window.
  useEffect(() => {
    if (!draftHydratedRef.current || isPreview) return;
    try {
      if (submitted) {
        sessionStorage.removeItem(draftKey);
      } else if (responses.size > 0 || passedIds.size > 0) {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            responses: Array.from(responses.entries()),
            passedIds: Array.from(passedIds),
          }),
        );
      }
    } catch {
      // storage full/unavailable — non-fatal
    }
  }, [responses, passedIds, submitted, isPreview, draftKey]);
  // Whether the active checkpoint overlay is collapsed for review. Collapsing does
  // NOT clear activeId (the answer gate stays) — it only frees the scrubber so the
  // student can rewatch the already-seen region before answering.
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

  // Pending checkpoints (not yet passed) ordered by startSeconds.
  // MEMOISED: this used to be a fresh array every render, which gave
  // handleTimeUpdate (and the player effects keyed on its identity) a new
  // identity on every render. Combined with the seek guard's state updates that
  // produced a synchronous re-render→re-subscribe storm during fast scrubbing
  // that froze the page. Memoising stabilises identity so the cascade stops.
  const pendingCheckpoints = useMemo(
    () =>
      lessonInteractions
        .filter((it) => it.startSeconds > 0 && !passedIds.has(it.id))
        .sort((a, b) => a.startSeconds - b.startSeconds),
    [lessonInteractions, passedIds],
  );

  const handleTimeUpdate = useCallback(
    (t: number) => {
      // Accumulate actual watched seconds: only count continuous forward deltas
      // (delta ≤ MAX_WATCH_DELTA_SECONDS) so seeking to the end doesn't inflate the metric.
      // Skip accumulation during: initial load, active checkpoints (video paused), or after submit.
      if (!activeId && !submitted && !isInitialLoadRef.current) {
        const prev = prevTimeRef.current;
        const delta = t - prev;
        if (delta > 0 && delta <= MAX_WATCH_DELTA_SECONDS) {
          watchedSecondsRef.current += delta;
          // Advance the high-water mark ONLY on genuine forward playback (never on
          // seeks) so the seek guard can distinguish rewatch from fast-forward.
          if (t > maxWatchedSecondsRef.current) {
            maxWatchedSecondsRef.current = t;
            // Throttle the state push (~1×/s) for the locked-region scrubber band.
            if (t - lastMaxWatchedPushRef.current >= 1) {
              lastMaxWatchedPushRef.current = t;
              setMaxWatchedSeconds(t);
            }
          }
        }
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

  // Fire the final checkpoint(s) on video end. The last interaction's startSeconds
  // can sit at/after duration (incl. legacy data with startSeconds >= duration), so
  // the timeupdate hit-test never fires it. When the video ends, activate the
  // earliest un-passed pending checkpoint whose startSeconds <= duration + epsilon
  // instead of falling through to the results screen.
  const handleEnded = useCallback(() => {
    if (submitted || activeId) return;
    const video = videoRef.current;
    const duration = video?.duration ?? 0;
    const candidate = pendingCheckpoints.find(
      (c) => !duration || c.startSeconds <= duration + CHECKPOINT_EPSILON_SECONDS,
    );
    if (!candidate) return;
    if (video) video.pause();
    if (!questionShownAtRef.current.has(candidate.id)) {
      questionShownAtRef.current.set(candidate.id, Date.now());
    }
    setActiveId(candidate.id);
  }, [submitted, activeId, pendingCheckpoints]);

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

  // While a checkpoint is active: the answer gate stays (activeId only clears on
  // handleContinue), but the student MAY press play to re-watch the already-seen
  // region. Playback auto-re-pauses once it reaches the high-water mark so they
  // cannot watch past the unanswered checkpoint.
  useEffect(() => {
    if (!activeId) return;
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => {
      // Only block play at/after the high-water mark; allow rewatching earlier.
      if (video.currentTime >= maxWatchedSecondsRef.current - FORWARD_SEEK_SLACK_S) {
        video.pause();
      }
    };
    const onTimeUpdate = () => {
      // Auto re-pause when a rewatch catches up to the high-water mark.
      if (video.currentTime >= maxWatchedSecondsRef.current - FORWARD_SEEK_SLACK_S) {
        video.pause();
      }
    };
    onPlay();
    video.addEventListener("play", onPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [activeId]);

  // Seek guard (students only): rewind/review freely, and jump FORWARD up to (but
  // not past) the next UNANSWERED checkpoint. Scrubbing beyond that checkpoint snaps
  // back to it and surfaces it, so a learner can navigate the lesson freely but cannot
  // skip a quiz they have not completed (Udemy-style navigation + checkpoint gating).
  // Once every checkpoint is answered there is no gate and seeking is unrestricted.
  // Teachers in preview seek without restriction.
  const nextGate = pendingCheckpoints[0];
  // Re-entry guard: writing video.currentTime inside a seeking/seeked handler
  // fires ANOTHER seeking/seeked event, which re-enters guardSeek. Under fast
  // repeated scrubbing those self-induced events interleave with real ones into
  // a synchronous storm that saturates the main thread (the freeze). The flag
  // makes the handler ignore the seek event its own correction caused.
  const clampingRef = useRef(false);
  useEffect(() => {
    if (isPreview || !nextGate) return;
    const video = videoRef.current;
    if (!video) return;
    const guardSeek = () => {
      if (clampingRef.current) return; // ignore the event our own clamp caused
      // Ignore the resume-seek the player performs on mount (loadedmetadata →
      // initialPosition) plus the poster-fragment seek. Those fire seeking/seeked
      // before the student has played anything; clamping on them yanks the video
      // around on entry. Real forward-skips clear isInitialLoadRef (first play /
      // a >1s timeupdate move) before reaching the guard.
      if (isInitialLoadRef.current) return;
      if (video.currentTime > nextGate.startSeconds + FORWARD_SEEK_SLACK_S) {
        clampingRef.current = true;
        video.currentTime = nextGate.startSeconds;
        prevTimeRef.current = nextGate.startSeconds;
        // Trying to scrub past an unanswered checkpoint surfaces it (the gate), so
        // the learner must complete it before continuing past this point.
        setActiveId((cur) => cur ?? nextGate.id);
        // Release the guard after the correction settles (the browser fires the
        // induced seeking/seeked within the same tick).
        window.setTimeout(() => {
          clampingRef.current = false;
        }, 0);
      }
    };
    video.addEventListener("seeking", guardSeek);
    video.addEventListener("seeked", guardSeek);
    return () => {
      video.removeEventListener("seeking", guardSeek);
      video.removeEventListener("seeked", guardSeek);
    };
  }, [isPreview, playerKey, nextGate]);

  // Surface a checkpoint that the resumed position has already passed. On return
  // to a lesson, the saved position can be AT/just before an unanswered gate
  // (see the save-position clamp in the player); the forward-crossing hit-test
  // in handleTimeUpdate never fires for a gate we resume on top of, so without
  // this the question would be silently skipped. Runs once after interactions
  // load. (P6 fix.)
  const initialGateCheckedRef = useRef(false);
  useEffect(() => {
    if (initialGateCheckedRef.current || isPreview || submitted) return;
    if (lessonInteractions.length === 0) return;
    initialGateCheckedRef.current = true;
    // Only relevant when actually RESUMING (initialPosition meaningfully > 0). At
    // a fresh start (initialPosition ≈ 0) a checkpoint whose startSeconds sits
    // within CHECKPOINT_EPSILON of zero would otherwise satisfy `0 >= start -
    // epsilon` and pop the question immediately on entry — before the student has
    // watched anything. The normal forward-crossing hit-test in handleTimeUpdate
    // surfaces such an early checkpoint on first play instead.
    if (initialPosition <= CHECKPOINT_EPSILON_SECONDS) return;
    const missed = pendingCheckpoints.find(
      (c) => initialPosition >= c.startSeconds - CHECKPOINT_EPSILON_SECONDS,
    );
    if (missed) {
      if (!questionShownAtRef.current.has(missed.id)) {
        questionShownAtRef.current.set(missed.id, Date.now());
      }
      setActiveId((cur) => cur ?? missed.id);
    }
  }, [isPreview, submitted, lessonInteractions, pendingCheckpoints, initialPosition]);

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
    watchedSecondsRef.current = 0;
    maxWatchedSecondsRef.current = 0;
    lastMaxWatchedPushRef.current = 0;
    setMaxWatchedSeconds(0);
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
    // Use accumulated watched seconds (not high-water mark) so seeking to the
    // end cannot game the metric.
    return Math.min(1, Math.max(0, watchedSecondsRef.current / duration));
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

  // Checkpoint body rendered inside the single in-frame overlay. `index`/`total`
  // label the active question's position within its cluster.
  function renderCheckpoint(index: number, total: number) {
    if (!activeInteraction) return null;
    return (
      <>
        <InteractionCheckpoint
          interaction={activeInteraction}
          index={index}
          total={total}
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
      </>
    );
  }

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

        <div ref={containerRef} data-testid="lesson-player-frame" className="relative w-full rounded-md overflow-hidden border bg-black shadow-sm group [&:fullscreen]:h-screen [&:fullscreen]:rounded-none [&:fullscreen]:border-none">
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
            onEnded={handleEnded}
            maxWatchedSeconds={isPreview ? undefined : maxWatchedSeconds}
            maxSavablePositionSeconds={isPreview ? undefined : nextGate?.startSeconds}
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
          {/* In-frame interaction overlay — a direct child of the player
              container (containerRef), so it stays INSIDE the video frame in
              BOTH normal and fullscreen. At a checkpoint it covers the video;
              the student answers to continue (forward-seeking past an unanswered
              checkpoint stays blocked by the seek gate, not by this overlay). */}
          {!submitted && activeInteraction && (() => {
            const cluster = lessonInteractions
              .filter((it) => it.startSeconds === activeInteraction.startSeconds)
              .sort((a, b) => a.orderIndex - b.orderIndex);
            const clusterIndex = cluster.findIndex((it) => it.id === activeInteraction.id) + 1;
            return (
              <div
                data-testid="quiz-checkpoint-overlay"
                className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col overflow-y-auto text-foreground animate-in fade-in duration-200"
              >
                <div className="w-full h-full bg-card p-6 md:p-8 overflow-y-auto flex flex-col justify-between">
                  {renderCheckpoint(clusterIndex, cluster.length)}
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
          nextLessonHref={nextLessonHref}
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
