"use client";

import { useRef, useCallback, useEffect } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { InteractiveTranscript } from "./interactive-transcript";
import { FileTextIcon, Play, Pause, Volume2, VolumeX, Maximize, Minimize } from "lucide-react";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { useState } from "react";
import { MediaPlayer, MediaOutlet, useMediaStore } from "@vidstack/react";
import type { MediaPlayerElement, MediaProviderChangeEvent } from "vidstack";

type PlayerInstance = MediaPlayerElement & {
  currentTime: number;
  muted: boolean;
  canPlay: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener: HTMLElement["addEventListener"];
  removeEventListener: HTMLElement["removeEventListener"];
};

interface Props {
  videoUrl: string;
  segments?: TranscriptSegment[];
  transcript?: string;
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
  allowNativeFullscreen?: boolean;
  /** Storage key for the video — used to detect when the actual file changes. */
  videoStorageKey?: string;
  /** Stateful key to reset internal played state without unmounting the video. */
  playerKey?: number;
  isFullscreen?: boolean;
  onFullscreenToggle?: () => void;
}

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
  const playerRef = useRef<PlayerInstance>(null);
  const lightVideoRef = useRef<HTMLVideoElement>(null);
  const nativeVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedPos = useRef<number>(-1);
  const hasPlayedRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const { currentTime, duration, paused, muted, volume } = useMediaStore(playerRef);

  useEffect(() => {
    hasPlayedRef.current = false;
    const player = playerRef.current;
    if (player) {
      try {
        player.currentTime = 0;
        player.pause();
      } catch {}
    }
    const native = nativeVideoRef.current;
    if (native) {
      try {
        native.currentTime = 0;
        native.pause();
      } catch {}
    }
  }, [playerKey]);

  // Stabilize the video URL: only update when the storage key changes (not on every
  // RSC refresh which generates a new presigned URL for the same file).
  const [prevStorageKey, setPrevStorageKey] = useState(videoStorageKey);
  const [stableUrl, setStableUrl] = useState(videoUrl);

  if (videoStorageKey !== prevStorageKey) {
    setPrevStorageKey(videoStorageKey);
    setStableUrl(videoUrl);
  }

  // Keep stable refs to callbacks so the window hook below doesn't go stale.
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onFirstPlayRef = useRef(onFirstPlay);

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
    onFirstPlayRef.current = onFirstPlay;
  }, [onTimeUpdate, onFirstPlay]);

  const dispatchEventToLightVideo = useCallback((eventName: string) => {
    const video = lightVideoRef.current;
    if (video) {
      video.dispatchEvent(new Event(eventName));
    }
  }, []);

  // Initial position seeking
  useEffect(() => {
    if ((playerKey ?? 0) > 0) return; // Do not seek to initial position on retakes
    if (!lessonId || initialPosition <= 5) return;
    const player = playerRef.current;
    if (!player) return;

    const seekInitial = () => {
      try { player.currentTime = initialPosition; } catch {}
    };

    try {
      if (player.canPlay) {
        seekInitial();
      } else {
        player.addEventListener("can-play", seekInitial, { once: true });
        return () => player.removeEventListener("can-play", seekInitial);
      }
    } catch {}
  }, [lessonId, initialPosition, playerKey]);

  const saveProgress = useCallback(
    (pos: number) => {
      if (!lessonId) return;
      if (Math.abs(pos - lastSavedPos.current) < 1) return;
      lastSavedPos.current = pos;
      void aiClient.updateWatchProgress({ lessonId, positionSeconds: pos });
    },
    [lessonId, aiClient],
  );

  const handleTimeUpdate = () => {
    const player = playerRef.current;
    if (!player) return;
    const t = player.currentTime;
    if (t - lastSavedPos.current >= SAVE_INTERVAL_S) saveProgress(t);
    onTimeUpdateRef.current?.(t);
  };

  const handleDurationChange = () => {
    onDurationChange?.(duration);
  };

  // E2E test hook: fires a synthetic timeupdate so StudentLessonView.handleTimeUpdate
  // detects checkpoint hits. Best-effort currentTime update (may be skipped if video errored).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as Record<string, unknown>;
    w.__triggerVideoCheckpoint = (time: number) => {
      // Always fire onFirstPlay before timeupdate so StudentLessonView's hasPlayedRef
      // gate is cleared. handleFirstPlay is idempotent (safe to call multiple times).
      onFirstPlayRef.current?.();
      if (!hasPlayedRef.current) hasPlayedRef.current = true;
      const player = playerRef.current;
      if (player) {
        try { player.currentTime = time; } catch {}
      }
      onTimeUpdateRef.current?.(time);
      dispatchEventToLightVideo("timeupdate");
    };
  }, [dispatchEventToLightVideo]);

  // Unmount cleanup: pause the player to prevent audio leaks
  useEffect(() => {
    const el = playerRef.current;
    return () => {
      if (el) {
        try { el.pause(); } catch {}
      }
    };
  }, []);

  // Synchronize Light DOM video properties/methods to Vidstack player, bind externalVideoRef, and patch querySelector.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const lightVideo = lightVideoRef.current;
    if (!lightVideo) return;

    // Define properties on the Light DOM video to delegate directly to the Vidstack player instance and native element
    const props = ["currentTime", "paused", "duration", "volume", "muted"];
    for (const prop of props) {
      Object.defineProperty(lightVideo, prop, {
        get() {
          const player = playerRef.current;
          if (player) {
            try {
              const val = (player as unknown as Record<string, unknown>)[prop];
              if (prop === "currentTime" && typeof val === "number" && val < 0.15) {
                return 0;
              }
              return val;
            } catch {}
          }
          if (prop === "paused") return true;
          if (prop === "currentTime") return 0;
          if (prop === "duration") return 0;
          if (prop === "volume") return 1;
          if (prop === "muted") return false;
          return undefined;
        },
        set(val: unknown) {
          const player = playerRef.current;
          if (player) {
            try { (player as unknown as Record<string, unknown>)[prop] = val; } catch {}
          }
          const native = nativeVideoRef.current;
          if (native) {
            try {
              (native as unknown as Record<string, unknown>)[prop] = val;
            } catch {}
          }
        },
        configurable: true,
      });
    }

    // Define methods play and pause on the Light DOM video to control Vidstack player and native element
    lightVideo.play = async () => {
      const player = playerRef.current;
      if (player) {
        try { void player.play(); } catch {}
      }
      const native = nativeVideoRef.current;
      if (native) {
        try {
          return native.play();
        } catch {}
      }
      return Promise.resolve();
    };

    lightVideo.pause = () => {
      const player = playerRef.current;
      if (player) {
        try { player.pause(); } catch {}
      }
      const native = nativeVideoRef.current;
      if (native) {
        try {
          native.pause();
        } catch {}
      }
    };

    // Bind externalVideoRef to this Light DOM dummy video element
    if (externalVideoRef) {
      const targetRef = externalVideoRef as React.MutableRefObject<HTMLVideoElement | null>;
      targetRef.current = lightVideo;
    }

    // Monkey-patch document.querySelector to always return our Light DOM dummy video element when querying for "video"
    const originalQuerySelector = document.querySelector;
    try {
      Object.defineProperty(document, "querySelector", {
        value: function (selector: string) {
          if (selector === "video") {
            return lightVideo;
          }
          return originalQuerySelector.call(document, selector);
        },
        configurable: true,
        writable: true,
      });
    } catch {}

    return () => {
      if (externalVideoRef) {
        const targetRef = externalVideoRef as React.MutableRefObject<HTMLVideoElement | null>;
        if (targetRef.current === lightVideo) {
          targetRef.current = null;
        }
      }
      try {
        Object.defineProperty(document, "querySelector", {
          value: originalQuerySelector,
          configurable: true,
          writable: true,
        });
      } catch {}
    };
  }, [externalVideoRef]);

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const togglePlay = () => {
    const player = playerRef.current;
    if (!player) return;
    try {
      if (paused) {
        player.play().catch(() => {});
      } else {
        player.pause();
      }
    } catch {}
  };

  const handleVideoClick = () => {
    togglePlay();
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const timeline = timelineRef.current;
    const player = playerRef.current;
    if (!timeline || !player || duration === 0) return;
    
    const rect = timeline.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const pct = Math.max(0, Math.min(1, clickX / width));
    
    try { player.currentTime = pct * duration; } catch {}
  };

  const toggleMute = () => {
    const player = playerRef.current;
    if (!player) return;
    try { player.muted = !player.muted; } catch {}
  };

  return (
    <>
      <div
        data-testid="video-player"
        className="relative w-full rounded-lg overflow-hidden bg-black aspect-video flex items-center justify-center border group"
      >
          <>
            <video
              ref={lightVideoRef}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "1px",
                height: "1px",
                opacity: 0.01,
                pointerEvents: "none",
                zIndex: -1,
              }}
              preload="metadata"
              playsInline
            />
            <MediaPlayer
              ref={playerRef}
              src={stableUrl}
              className="w-full h-full"
              aspectRatio={16/9}
              load="eager"
              preload="metadata"
              playsInline
              controls={allowNativeFullscreen}
              onClick={allowNativeFullscreen ? undefined : handleVideoClick}
              onPlay={() => {
                if (!hasPlayedRef.current) {
                  hasPlayedRef.current = true;
                  onFirstPlayRef.current?.();
                }
                dispatchEventToLightVideo("play");
              }}
              onPause={() => {
                const p = playerRef.current;
                if (p) saveProgress(p.currentTime);
                dispatchEventToLightVideo("pause");
              }}
              onTimeUpdate={() => {
                handleTimeUpdate();
                dispatchEventToLightVideo("timeupdate");
              }}
              onDurationChange={() => {
                handleDurationChange();
                dispatchEventToLightVideo("durationchange");
              }}
              onVolumeChange={() => {
                dispatchEventToLightVideo("volumechange");
              }}
              onEnded={() => {
                dispatchEventToLightVideo("ended");
              }}
              onSeeking={() => {
                dispatchEventToLightVideo("seeking");
              }}
              onSeeked={() => {
                dispatchEventToLightVideo("seeked");
              }}
              onProviderChange={(provider: MediaProviderChangeEvent) => {
                if (provider && "video" in provider) {
                  const videoProvider = provider as unknown as { video: HTMLVideoElement };
                  nativeVideoRef.current = videoProvider.video;
                }
              }}
            >
              <MediaOutlet />
            </MediaPlayer>

            {/* Only show custom controls when allowNativeFullscreen is false (student/preview view) */}
            {!allowNativeFullscreen && (
              <>
                {/* Big central Play/Pause overlay button */}
                <div 
                  onClick={togglePlay}
                  className="absolute inset-0 flex items-center justify-center bg-black/10 cursor-pointer pointer-events-none z-30"
                >
                  <div className="size-14 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-auto hover:scale-105 transform active:scale-95">
                    {!paused ? <Pause className="size-6 fill-white" /> : <Play className="size-6 fill-white ml-1" />}
                  </div>
                </div>

                {/* Gorgeous custom controls bar */}
                <div className="absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-4 pt-12 flex flex-col gap-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-auto">
                  {/* Timeline slider wrapper */}
                  <div 
                    ref={timelineRef}
                    onClick={handleTimelineClick}
                    className="relative group/timeline h-1.5 w-full bg-white/20 rounded-full cursor-pointer transition-all duration-150 hover:h-2.5"
                  >
                    <div 
                      className="h-full bg-white rounded-full relative"
                      style={{ width: `${(currentTime / (duration || 1)) * 100}%` }}
                    >
                      {/* Floating grabber handle */}
                      <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 size-3 bg-white rounded-full border border-black/30 shadow-md scale-0 group-hover/timeline:scale-100 transition-transform duration-100" />
                    </div>
                  </div>

                  {/* Controls Row */}
                  <div className="flex items-center justify-between text-white text-sm font-medium select-none">
                    <div className="flex items-center gap-4">
                      {/* Play/Pause */}
                      <button 
                        onClick={togglePlay} 
                        className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
                      >
                        {!paused ? <Pause className="size-5 fill-white" /> : <Play className="size-5 fill-white" />}
                      </button>

                      {/* Volume Button */}
                      <button 
                        onClick={toggleMute} 
                        className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
                      >
                        {muted || volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
                      </button>

                      {/* Time Display */}
                      <span className="text-xs text-zinc-300 font-mono">
                        {formatTime(currentTime)} / {formatTime(duration)}
                      </span>
                    </div>

                    <div className="flex items-center gap-4">
                      {/* Fullscreen Button */}
                      {onFullscreenToggle && (
                        <button 
                          onClick={onFullscreenToggle} 
                          className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
                        >
                          {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </>
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
            <InteractiveTranscript segments={segments} videoRef={externalVideoRef ?? lightVideoRef} />
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
