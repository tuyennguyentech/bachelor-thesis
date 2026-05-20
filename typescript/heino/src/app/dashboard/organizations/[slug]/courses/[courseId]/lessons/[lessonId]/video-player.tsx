"use client";

import { useRef, useCallback, useEffect } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { InteractiveTranscript } from "./interactive-transcript";
import { FileTextIcon, VideoOffIcon } from "lucide-react";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { useState } from "react";

interface Props {
  videoUrl: string;
  segments: TranscriptSegment[];
  transcript: string;
  /** Unused; kept for backward-compat with teacher view callers that pass checkpoints={[]}. */
  checkpoints?: unknown[];
  lessonId?: string;
  initialPosition?: number;
  token: string;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** Called on every timeupdate event with the current position in seconds. */
  onTimeUpdate?: (currentTime: number) => void;
  /** Called once on the first Play event. */
  onFirstPlay?: () => void;
  /** Called when video metadata loads, with the total duration in seconds. */
  onDurationChange?: (duration: number) => void;
  showTranscript?: boolean;
}

const SAVE_INTERVAL_S = 10;

export function VideoPlayer({
  videoUrl,
  segments,
  transcript,
  lessonId,
  initialPosition = 0,
  token,
  videoRef: externalVideoRef,
  onTimeUpdate,
  onFirstPlay,
  onDurationChange,
  showTranscript = true,
}: Props) {
  const aiClient = useRichterWebClient(AIService, token);
  const internalRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalVideoRef ?? internalRef;
  const lastSavedPos = useRef<number>(-1);
  const hasPlayedRef = useRef(false);
  const [videoError, setVideoError] = useState(false);

  // Keep stable refs to callbacks so the window hook below doesn't go stale.
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;

  useEffect(() => {
    if (!lessonId || initialPosition <= 5) return;
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => { video.currentTime = initialPosition; };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    return () => video.removeEventListener("loadedmetadata", onLoaded);
  }, [lessonId, initialPosition, videoRef]);

  const saveProgress = useCallback(
    (pos: number) => {
      if (!lessonId) return;
      if (Math.abs(pos - lastSavedPos.current) < 1) return;
      lastSavedPos.current = pos;
      void aiClient.updateWatchProgress({ lessonId, positionSeconds: pos });
    },
    [lessonId, aiClient],
  );

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const t = video.currentTime;
    if (t - lastSavedPos.current >= SAVE_INTERVAL_S) saveProgress(t);
    onTimeUpdateRef.current?.(t);
  }, [saveProgress, videoRef]);

  // E2E test hook: fires a synthetic timeupdate so StudentLessonView.handleTimeUpdate
  // detects checkpoint hits. Best-effort currentTime update (may be skipped if video errored).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as Record<string, unknown>;
    w.__triggerVideoCheckpoint = (time: number) => {
      const video = videoRef.current;
      if (video) video.currentTime = time;
      onTimeUpdateRef.current?.(time);
    };
    return () => { delete w.__triggerVideoCheckpoint; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        data-testid="video-player"
        className="w-full rounded-lg border overflow-hidden bg-black aspect-video flex items-center justify-center"
      >
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
            onLoadedMetadata={() => {
              const d = videoRef.current?.duration ?? 0;
              onDurationChange?.(d);
            }}
            onTimeUpdate={handleTimeUpdate}
            onError={() => setVideoError(true)}
            onPause={() => {
              if (videoRef.current) saveProgress(videoRef.current.currentTime);
            }}
            onPlay={() => {
              if (!hasPlayedRef.current) {
                hasPlayedRef.current = true;
                onFirstPlay?.();
              }
            }}
          />
        )}
      </div>

      {showTranscript && (segments.length > 0 || transcript) && (
        <div className="rounded-lg border p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Phiên âm nội dung</h2>
            {segments.length > 0 && (
              <span className="text-xs text-muted-foreground">(nhấn vào đoạn để tua video)</span>
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
