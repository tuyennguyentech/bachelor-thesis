"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { InteractiveTranscript } from "./interactive-transcript";
import { QuizCheckpoint, type CheckpointQuestion } from "./quiz-checkpoint";
import { FileTextIcon, VideoOffIcon } from "lucide-react";
import { useRichterWebClient } from "@/lib/connect-webclient";

interface Props {
  videoUrl: string;
  segments: TranscriptSegment[];
  transcript: string;
  checkpoints: CheckpointQuestion[];
  lessonId?: string;
  initialPosition?: number;
  token: string;
}

// Save watch position at most every SAVE_INTERVAL_S seconds of real time.
const SAVE_INTERVAL_S = 10;

export function VideoPlayer({ videoUrl, segments, transcript, checkpoints, lessonId, initialPosition = 0, token }: Props) {
  const aiClient = useRichterWebClient(AIService, token);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSavedPos = useRef<number>(-1);
  // IDs of checkpoints that have been shown this session
  const [passedIds, setPassedIds] = useState<Set<string>>(new Set());
  const [activeCheckpoint, setActiveCheckpoint] = useState<CheckpointQuestion | null>(null);
  const [videoError, setVideoError] = useState(false);

  // Seek to saved position on first load.
  useEffect(() => {
    if (!lessonId || initialPosition <= 5) return;
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => { video.currentTime = initialPosition; };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    return () => video.removeEventListener("loadedmetadata", onLoaded);
  }, [lessonId, initialPosition]);

  const saveProgress = useCallback((pos: number) => {
    if (!lessonId) return;
    if (Math.abs(pos - lastSavedPos.current) < 1) return;
    lastSavedPos.current = pos;
    void aiClient.updateWatchProgress({ lessonId, positionSeconds: pos });
  }, [lessonId, aiClient]);

  // Sort checkpoints by startSeconds so we can find the first upcoming one
  const pending = checkpoints
    .filter((c) => c.startSeconds > 0 && !passedIds.has(c.id))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  // Refs so the E2E window hook always sees the latest values without re-registering.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const activeCheckpointRef = useRef(activeCheckpoint);
  activeCheckpointRef.current = activeCheckpoint;

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const t = video.currentTime;
    // Save progress every SAVE_INTERVAL_S seconds.
    if (t - lastSavedPos.current >= SAVE_INTERVAL_S) {
      saveProgress(t);
    }
    if (activeCheckpoint) return;
    // Find the first pending checkpoint whose start_seconds has been passed
    const hit = pending.find((c) => t >= c.startSeconds);
    if (hit) {
      video.pause();
      setActiveCheckpoint(hit);
    }
  }, [activeCheckpoint, pending, saveProgress]);

  const handleContinue = useCallback(() => {
    if (!activeCheckpoint) return;
    setPassedIds((prev) => new Set([...prev, activeCheckpoint.id]));
    setActiveCheckpoint(null);
    videoRef.current?.play();
  }, [activeCheckpoint]);

  // E2E test hook: allows tests to trigger a checkpoint without a real seekable video.
  // Registered once via empty deps; reads current values through refs to avoid re-registration
  // races that would briefly remove the function from window during re-renders.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as Record<string, unknown>;
    w.__triggerVideoCheckpoint = (time: number) => {
      if (activeCheckpointRef.current) return;
      const hit = pendingRef.current.find((c) => time >= c.startSeconds);
      if (!hit) return;
      videoRef.current?.pause();
      setActiveCheckpoint(hit);
    };
    return () => { delete w.__triggerVideoCheckpoint; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div data-testid="video-player" className="rounded-lg border overflow-hidden bg-black aspect-video flex items-center justify-center">
        {videoError ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground p-8">
            <VideoOffIcon className="size-10 opacity-30" />
            <p className="text-sm">Video không thể tải. Vui lòng thử lại sau.</p>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            className="w-full h-full"
            preload="metadata"
            onTimeUpdate={handleTimeUpdate}
            onError={() => setVideoError(true)}
            onPause={() => { if (videoRef.current) saveProgress(videoRef.current.currentTime); }}
            onPlay={() => { if (activeCheckpoint) videoRef.current?.pause(); }}
            onSeeked={() => {
              if (activeCheckpoint && videoRef.current) {
                videoRef.current.currentTime = activeCheckpoint.startSeconds;
              }
            }}
          />
        )}
      </div>

      {/* Quiz checkpoint — appears below the video when triggered */}
      {activeCheckpoint && (
        <QuizCheckpoint question={activeCheckpoint} onContinue={handleContinue} />
      )}

      {/* Interactive transcript or plain text */}
      {(segments.length > 0 || transcript) && (
        <div className="rounded-lg border p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Phiên âm nội dung</h2>
            {segments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                (nhấn vào đoạn để tua video)
              </span>
            )}
          </div>
          {segments.length > 0 ? (
            <InteractiveTranscript segments={segments} videoRef={videoRef} />
          ) : (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {transcript}
            </p>
          )}
        </div>
      )}
    </>
  );
}
