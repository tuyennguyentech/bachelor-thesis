"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { useRouter } from "next/navigation";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractiveTranscript } from "./interactive-transcript";
import { FileTextIcon } from "lucide-react";
import { VideoPlayerControls } from "./video-player-controls";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { videoPlayerConfig } from "@/lib/client-config";

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
  /** Called when the video reaches its end. */
  onEnded?: () => void;
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
  interactions?: LessonInteraction[];
  /** High-water mark (seconds) of legitimately-reached playback. When set, the
   *  scrubber greys out the locked forward region beyond it. Omit for free seeking
   *  (e.g. teacher preview). */
  maxWatchedSeconds?: number;
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

const SAVE_INTERVAL_S = videoPlayerConfig.saveIntervalS;

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
  onEnded,
  onDurationChange,
  showTranscript = true,
  allowNativeFullscreen = true,
  videoStorageKey,
  playerKey,
  isFullscreen = false,
  onFullscreenToggle,
  interactions = [],
  maxWatchedSeconds,
}: Props) {
  const router = useRouter();
  const aiClient = useRichterWebClient(AIService, token);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nativeVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedPos = useRef<number>(-1);
  /** Position (seconds) marking the start of the watched interval reported on the
   *  next save. Tracks continuous forward playback; reset to the landing position
   *  whenever a seek occurs so seeked-over regions are never counted. */
  const intervalFromRef = useRef<number>(initialPosition);
  /** Last position observed via a timeupdate tick, used to detect discontinuities. */
  const lastTickPosRef = useRef<number>(initialPosition);
  /** Set when a seek happened since the last save, so that save reports no interval. */
  const seekedSinceSaveRef = useRef(false);
  const lastSetCurrentTime = useRef<number | null>(null);
  const hasPlayedRef = useRef(false);
  const durationRef = useRef(0);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  // Player error state — surfaces video element onError events (expired presigned
  // URL, network down, codec mismatch) so the user sees a useful message instead
  // of a silent black screen.
  const [playerError, setPlayerError] = useState<string | null>(null);

  // Stabilize the video URL: only update when the storage key changes, not on
  // every RSC refresh that creates a new presigned URL for the same object.
  const stableIdentity = videoStorageKey ?? videoUrl;
  const stableIdentityRef = useRef(stableIdentity);
  const acceptNextUrlRef = useRef(false);
  const [stableUrl, setStableUrl] = useState(videoUrl);

  useEffect(() => {
    const identityChanged = stableIdentityRef.current !== stableIdentity;
    const shouldAcceptRetryUrl = acceptNextUrlRef.current && videoUrl !== stableUrl;
    if (!identityChanged && !shouldAcceptRetryUrl) return;
    stableIdentityRef.current = stableIdentity;
    acceptNextUrlRef.current = false;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setStableUrl(videoUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [stableIdentity, stableUrl, videoUrl]);

  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onFirstPlayRef = useRef(onFirstPlay);
  const onEndedRef = useRef(onEnded);

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
    onFirstPlayRef.current = onFirstPlay;
    onEndedRef.current = onEnded;
  }, [onTimeUpdate, onFirstPlay, onEnded]);

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
    lastSetCurrentTime.current = null;
    lastSavedPos.current = -1;
    intervalFromRef.current = 0;
    lastTickPosRef.current = 0;
    seekedSinceSaveRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlayerError(null);
    const video = nativeVideoRef.current;
    if (!video) return;
    try {
      video.pause();
      video.currentTime = 0;
    } catch {}
  }, [playerKey]);

  // When the video file itself changes (new storage key or new presigned URL),
  // reset the error overlay so a fresh source gets a clean slate.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlayerError(null);
  }, [stableUrl]);

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
      // Report the continuous-play interval [from, to] since the last interval
      // anchor, but ONLY when no seek occurred in between — a seek would make the
      // span non-continuous and let students inflate %watch by scrubbing. The
      // server uses these intervals for authoritative coverage; positionSeconds is
      // still always sent for resume.
      let watchedFromSeconds = 0;
      let watchedToSeconds = 0;
      const from = intervalFromRef.current;
      if (!seekedSinceSaveRef.current && pos > from) {
        watchedFromSeconds = from;
        watchedToSeconds = pos;
      }
      // Next interval starts from the current position; clear the seek flag.
      intervalFromRef.current = pos;
      seekedSinceSaveRef.current = false;
      void aiClient.updateWatchProgress({
        lessonId,
        positionSeconds: pos,
        watchedFromSeconds,
        watchedToSeconds,
      });
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

    const handleSeek = (e: Event) => {
      const customEvent = e as CustomEvent<{ seconds: number }>;
      const video = nativeVideoRef.current;
      if (video) {
        try {
          video.currentTime = customEvent.detail.seconds;
          setCurrentTime(customEvent.detail.seconds);
        } catch {}
      }
    };

    window.addEventListener("seek-video", handleSeek);

    return () => {
      delete window.__triggerVideoCheckpoint;
      window.removeEventListener("seek-video", handleSeek);
    };
  }, []);

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

  /** Max gap (seconds) between consecutive timeupdate ticks that still counts as
   *  continuous playback. Larger jumps indicate a seek. timeupdate fires ~4×/s, so
   *  real steps are well under this; we tolerate buffering with a 1.5 s window. */
  const CONTINUOUS_TICK_GAP_S = 1.5;

  const handleNativeTimeUpdate = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    syncMediaDuration(video);
    const t = video.currentTime;
    // Detect a seek (forward or backward discontinuity) since the last tick. When
    // detected, the interval anchor jumps to the landing position and the save will
    // report no watched interval, so scrubbed-over spans are never counted.
    const gap = t - lastTickPosRef.current;
    if (gap < 0 || gap > CONTINUOUS_TICK_GAP_S) {
      seekedSinceSaveRef.current = true;
      intervalFromRef.current = t;
    }
    lastTickPosRef.current = t;
    // Throttle React state updates to ~4Hz (every 0.25s) so the timeline
    // gradient, the formatTime label, and any consumer of `currentTime`
    // re-render at human-noticeable rate instead of on every video timeupdate
    // event (which can fire up to 66Hz on some browsers). The parent component
    // already gets every tick via onTimeUpdate (refs only, no re-render).
    const lastSet = lastSetCurrentTime.current;
    if (lastSet === null || Math.abs(t - lastSet) >= 0.25 || t === 0) {
      lastSetCurrentTime.current = t;
      setCurrentTime(t);
    }
    if (t - lastSavedPos.current >= SAVE_INTERVAL_S) saveProgress(t);
    onTimeUpdateRef.current?.(t);
  };

  const handleLoadedMetadata = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    syncMediaDuration(video);
  };

  const handleError = () => {
    const video = nativeVideoRef.current;
    if (!video) return;
    const err = video.error;
    let msg = "Không thể phát video";
    if (err) {
      switch (err.code) {
        case 1: msg = "Video đã bị hủy tải"; break;
        case 2: msg = "Lỗi mạng khi tải video"; break;
        case 3: msg = "Lỗi giải mã video"; break;
        case 4: msg = "Định dạng video không được hỗ trợ hoặc liên kết đã hết hạn"; break;
        default: msg = `Lỗi video (mã ${err.code})`;
      }
    }
    setPlayerError(msg);
    setPaused(true);
  };

  const refreshVideoUrl = () => {
    acceptNextUrlRef.current = true;
    setPlayerError(null);
    router.refresh();
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

  const handleVolumeSliderChange = (value: number) => {
    const video = nativeVideoRef.current;
    if (!video) return;
    video.volume = value;
    if (value > 0) video.muted = false;
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

  return (
    <>
      <div
        ref={containerRef}
        data-testid="video-player"
        className="relative w-full rounded-md overflow-hidden bg-black aspect-video flex items-center justify-center border group"
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
          onError={handleError}
          onEnded={() => {
            setPaused(true);
            handleNativeTimeUpdate();
            onEndedRef.current?.();
          }}
        />

        {playerError && (
          <div
            className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/85 text-white p-6 text-center"
            data-testid="video-error-overlay"
            role="alert"
          >
            <div className="max-w-sm flex flex-col items-center gap-3">
              <div className="text-3xl">⚠️</div>
              <p className="text-sm font-medium">{playerError}</p>
              <p className="text-xs text-zinc-300">
                Liên kết tải video chỉ có hiệu lực trong một khoảng thời gian. Bấm nút bên dưới để thử lại.
              </p>
              <button
                type="button"
                onClick={refreshVideoUrl}
                className="mt-2 px-4 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-sm font-medium border border-white/20 transition-colors"
              >
                Thử lại
              </button>
            </div>
          </div>
        )}

        <VideoPlayerControls
          allowFullscreen={Boolean(onFullscreenToggle || allowNativeFullscreen)}
          currentTime={currentTime}
          duration={duration}
          interactions={interactions}
          isFullscreen={isFullscreen}
          maxWatchedSeconds={maxWatchedSeconds}
          muted={muted}
          onSeekChange={handleSeekChange}
          onToggleFullscreen={toggleFullscreen}
          onToggleMute={toggleMute}
          onTogglePlay={togglePlay}
          onVolumeChange={handleVolumeSliderChange}
          paused={paused}
          volume={volume}
        />
      </div>

      {showTranscript && (segments.length > 0 || transcript) && (
        <div className="rounded-md border p-4 flex flex-col gap-3">
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
