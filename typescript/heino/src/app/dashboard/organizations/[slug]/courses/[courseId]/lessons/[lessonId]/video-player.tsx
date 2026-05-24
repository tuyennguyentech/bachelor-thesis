"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { InteractiveTranscript } from "./interactive-transcript";
import { FileTextIcon, Play, Pause, Volume2, VolumeX, Maximize, Minimize } from "lucide-react";
import { useRichterWebClient } from "@/lib/connect-webclient";

interface Props {
  videoUrl: string;
  segments?: TranscriptSegment[];
  transcript?: string;
  lessonId?: string;
  initialPosition?: number;
  token: string;
  videoRef?: RefObject<HTMLVideoElement | null>;
  /** Called on every timeupdate event with the current position in seconds. */
  onTimeUpdate?: (currentTime: number) => void;
  /** Called once on the first Play event. */
  onFirstPlay?: () => void;
  /** Called when video metadata loads, with the total duration in seconds. */
  onDurationChange?: (duration: number) => void;
  showTranscript?: boolean;
  allowNativeFullscreen?: boolean;
  /** Storage key for the video — used to detect when the actual file changes. */
  videoStorageKey?: string;
  /** Stateful key to reset internal played state without unmounting the video. */
  playerKey?: number;
  isFullscreen?: boolean;
  onFullscreenToggle?: () => void;
}

declare global {
  interface Window {
    __triggerVideoCheckpoint?: (time: number) => void;
  }
}

type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};

const SAVE_INTERVAL_S = 10;

export function VideoPlayer({
  videoUrl,
  segments = [],
  transcript = "",
  lessonId,
  initialPosition = 0,
  token,
  videoRef: externalVideoRef,
  onTimeUpdate,
  onFirstPlay,
  onDurationChange,
  showTranscript = true,
  allowNativeFullscreen = true,
  videoStorageKey,
  playerKey,
  isFullscreen = false,
  onFullscreenToggle,
}: Props) {
  const aiClient = useRichterWebClient(AIService, token);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nativeVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedPos = useRef<number>(-1);
  const hasPlayedRef = useRef(false);
  const durationRef = useRef(0);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  // Stabilize the video URL: only update when the storage key changes, not on
  // every RSC refresh that creates a new presigned URL for the same object.
  const stableIdentity = videoStorageKey ?? videoUrl;
  const stableIdentityRef = useRef(stableIdentity);
  const [stableUrl, setStableUrl] = useState(videoUrl);

  useEffect(() => {
    if (stableIdentityRef.current === stableIdentity) return;
    stableIdentityRef.current = stableIdentity;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setStableUrl(videoUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [stableIdentity, videoUrl]);

  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onFirstPlayRef = useRef(onFirstPlay);

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
    onFirstPlayRef.current = onFirstPlay;
  }, [onTimeUpdate, onFirstPlay]);

  const attachVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      nativeVideoRef.current = node;
      if (externalVideoRef) {
        const targetRef = externalVideoRef as MutableRefObject<HTMLVideoElement | null>;
        targetRef.current = node;
      }
    },
    [externalVideoRef],
  );

  useEffect(() => {
    return () => {
      const video = nativeVideoRef.current;
      if (video) {
        try { video.pause(); } catch {}
      }
      if (externalVideoRef) {
        const targetRef = externalVideoRef as MutableRefObject<HTMLVideoElement | null>;
        targetRef.current = null;
      }
    };
  }, [externalVideoRef]);

  useEffect(() => {
    hasPlayedRef.current = false;
    durationRef.current = 0;
    const video = nativeVideoRef.current;
    if (!video) return;
    try {
      video.pause();
      video.currentTime = 0;
    } catch {}
  }, [playerKey]);

  useEffect(() => {
    if ((playerKey ?? 0) > 0) return;
    if (!lessonId || initialPosition <= 5) return;
    const video = nativeVideoRef.current;
    if (!video) return;

    const syncDuration = (video: HTMLVideoElement) => {
      const mediaDuration = video.duration;
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
        durationRef.current = mediaDuration;
        setDuration(mediaDuration);
        onDurationChange?.(mediaDuration);
      }
    };

    const seekInitial = () => {
      try {
        syncDuration(video);
        const mediaDuration = video.duration;
        const seekTime =
          Number.isFinite(mediaDuration) && mediaDuration > 0 && initialPosition >= mediaDuration - 1
            ? 0
            : initialPosition;
        video.currentTime = seekTime;
        setCurrentTime(seekTime);
      } catch {}
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekInitial();
      return;
    }

    video.addEventListener("loadedmetadata", seekInitial, { once: true });
    return () => video.removeEventListener("loadedmetadata", seekInitial);
  }, [lessonId, initialPosition, playerKey, stableUrl, onDurationChange]);

  const saveProgress = useCallback(
    (pos: number) => {
      if (!lessonId) return;
      if (Math.abs(pos - lastSavedPos.current) < 1) return;
      lastSavedPos.current = pos;
      void aiClient.updateWatchProgress({ lessonId, positionSeconds: pos });
    },
    [lessonId, aiClient],
  );

  useEffect(() => {
    window.__triggerVideoCheckpoint = (time: number) => {
      onFirstPlayRef.current?.();
      if (!hasPlayedRef.current) hasPlayedRef.current = true;
      const video = nativeVideoRef.current;
      if (video) {
        try {
          video.currentTime = time;
          setCurrentTime(time);
        } catch {}
      }
      onTimeUpdateRef.current?.(time);
    };

    return () => {
      delete window.__triggerVideoCheckpoint;
    };
  }, []);

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const syncMediaDuration = useCallback(
    (video: HTMLVideoElement) => {
      const mediaDuration = video.duration;
      if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
      if (Math.abs(mediaDuration - durationRef.current) < 0.25) return;
      durationRef.current = mediaDuration;
      setDuration(mediaDuration);
      onDurationChange?.(mediaDuration);
    },
    [onDurationChange],
  );

  const blockPlaybackForCheckpoint = () =>
    typeof document !== "undefined" && document.querySelector('[data-testid="quiz-checkpoint"]');

  const togglePlay = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    if (blockPlaybackForCheckpoint()) {
      video.pause();
      return;
    }

    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const handleNativePlay = () => {
    const video = nativeVideoRef.current;
    if (video && blockPlaybackForCheckpoint()) {
      video.pause();
      setPaused(true);
      return;
    }

    if (video) syncMediaDuration(video);
    setPaused(false);
    if (!hasPlayedRef.current) {
      hasPlayedRef.current = true;
      onFirstPlayRef.current?.();
    }
  };

  const handleNativePause = () => {
    setPaused(true);
    const video = nativeVideoRef.current;
    if (video) saveProgress(video.currentTime);
  };

  const handleNativeTimeUpdate = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    syncMediaDuration(video);
    const t = video.currentTime;
    setCurrentTime(t);
    if (t - lastSavedPos.current >= SAVE_INTERVAL_S) saveProgress(t);
    onTimeUpdateRef.current?.(t);
  };

  const handleLoadedMetadata = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    syncMediaDuration(video);
  };

  const handleVolumeChange = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    setVolume(video.volume);
    setMuted(video.muted);
  };

  const handleSeekChange = (value: number) => {
    const video = nativeVideoRef.current;
    if (!video || !Number.isFinite(value)) return;
    try {
      video.currentTime = value;
      setCurrentTime(value);
      onTimeUpdateRef.current?.(value);
    } catch {}
  };

  const toggleMute = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  };

  const toggleFullscreen = () => {
    if (onFullscreenToggle) {
      onFullscreenToggle();
      return;
    }
    if (!allowNativeFullscreen) return;

    const docExt = document as FullscreenDocument;
    const target = (containerRef.current ?? nativeVideoRef.current) as FullscreenTarget | null;
    if (!target) return;

    if (document.fullscreenElement || docExt.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (docExt.webkitExitFullscreen) {
        docExt.webkitExitFullscreen();
      }
      return;
    }

    if (target.requestFullscreen) {
      target.requestFullscreen().catch(() => {});
    } else if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    }
  };

  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const seekMax = duration > 0 ? duration : 0;
  const seekValue = Math.min(currentTime, seekMax);

  return (
    <>
      <div
        ref={containerRef}
        data-testid="video-player"
        className="relative w-full rounded-lg overflow-hidden bg-black aspect-video flex items-center justify-center border group"
      >
        <video
          key={stableIdentity}
          ref={attachVideoRef}
          src={stableUrl}
          className="absolute inset-0 h-full w-full bg-black object-contain"
          preload="metadata"
          playsInline
          controls={false}
          onClick={togglePlay}
          onPlay={handleNativePlay}
          onPause={handleNativePause}
          onTimeUpdate={handleNativeTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={handleLoadedMetadata}
          onCanPlay={handleLoadedMetadata}
          onDurationChange={handleLoadedMetadata}
          onVolumeChange={handleVolumeChange}
          onSeeked={handleNativeTimeUpdate}
          onEnded={() => {
            setPaused(true);
            handleNativeTimeUpdate();
          }}
        />

        <div
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/10 pointer-events-none"
        >
          <button
            type="button"
            aria-label={paused ? "Phát video" : "Tạm dừng video"}
            className="size-14 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-300 pointer-events-auto hover:scale-105 transform active:scale-95"
          >
            {!paused ? <Pause className="size-6 fill-white" /> : <Play className="size-6 fill-white ml-1" />}
          </button>
        </div>

        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-4 pt-12 flex flex-col gap-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300 pointer-events-auto"
        >
          <input
            type="range"
            min={0}
            max={seekMax}
            step={0.1}
            value={seekValue}
            aria-label="Tua video"
            disabled={duration <= 0}
            onChange={(e) => handleSeekChange(Number(e.target.value))}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-white disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: `linear-gradient(to right, white ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`,
            }}
          />

          <div className="flex items-center justify-between text-white text-sm font-medium select-none">
            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-label={paused ? "Phát video" : "Tạm dừng video"}
                onClick={togglePlay}
                className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
              >
                {!paused ? <Pause className="size-5 fill-white" /> : <Play className="size-5 fill-white" />}
              </button>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={muted || volume === 0 ? "Bật âm thanh" : "Tắt âm thanh"}
                  onClick={toggleMute}
                  className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
                >
                  {muted || volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  aria-label="Âm lượng"
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    const video = nativeVideoRef.current;
                    if (!video) return;
                    video.volume = val;
                    if (val > 0) video.muted = false;
                  }}
                  className="w-16 opacity-100 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white hover:bg-white/40 transition-all duration-150"
                />
              </div>

              <span className="text-xs text-zinc-300 font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {(onFullscreenToggle || allowNativeFullscreen) && (
              <button
                type="button"
                aria-label={isFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}
                onClick={toggleFullscreen}
                className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
              >
                {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
              </button>
            )}
          </div>
        </div>
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
            <InteractiveTranscript segments={segments} videoRef={externalVideoRef ?? nativeVideoRef} />
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
