"use client";

import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { formatTime } from "@/lib/format";

interface VideoPlayerControlsProps {
  allowFullscreen: boolean;
  currentTime: number;
  duration: number;
  interactions: LessonInteraction[];
  isFullscreen: boolean;
  /** High-water mark (seconds). When set, the scrubber greys the locked region
   *  beyond it (fast-forward blocked). Undefined = no locked band (free seek). */
  maxWatchedSeconds?: number;
  muted: boolean;
  onSeekChange: (value: number) => void;
  onToggleFullscreen: () => void;
  onToggleMute: () => void;
  onTogglePlay: () => void;
  onVolumeChange: (value: number) => void;
  paused: boolean;
  volume: number;
}

export function VideoPlayerControls({
  allowFullscreen,
  currentTime,
  duration,
  interactions,
  isFullscreen,
  maxWatchedSeconds,
  muted,
  onSeekChange,
  onToggleFullscreen,
  onToggleMute,
  onTogglePlay,
  onVolumeChange,
  paused,
  volume,
}: VideoPlayerControlsProps) {
  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const seekMax = duration > 0 ? duration : 0;
  const seekValue = Math.min(currentTime, seekMax);

  // Locked forward region: when a high-water mark is provided and sits below the
  // end, mark everything beyond it as locked (greyed) so the fast-forward block is
  // visible. lockPct is clamped to be at least the current progress.
  const hasLock =
    typeof maxWatchedSeconds === "number" && duration > 0 && maxWatchedSeconds < duration;
  const lockPct = hasLock
    ? Math.min(100, Math.max(progressPct, (maxWatchedSeconds! / duration) * 100))
    : 100;
  // 3-stop gradient: played (white) → reachable/watched (translucent white) → locked (grey).
  const trackBackground = hasLock
    ? `linear-gradient(to right, white ${progressPct}%, rgba(255,255,255,0.35) ${progressPct}%, rgba(255,255,255,0.35) ${lockPct}%, rgba(255,255,255,0.08) ${lockPct}%)`
    : `linear-gradient(to right, white ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)`;

  return (
    <>
      <div
        onClick={(e) => {
          e.stopPropagation();
          onTogglePlay();
        }}
        className="absolute inset-0 z-30 flex items-center justify-center bg-black/10 pointer-events-none"
      >
        <button
          type="button"
          aria-label={paused ? "Phát video" : "Tạm dừng video"}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePlay();
          }}
          className={`size-14 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-opacity duration-300 pointer-events-auto hover:scale-105 transform active:scale-95 ${paused ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        >
          {!paused ? <Pause className="size-6 fill-white" /> : <Play className="size-6 fill-white ml-1" />}
        </button>
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-4 pt-12 flex flex-col gap-3 transition-opacity duration-300 ${paused ? "opacity-100 pointer-events-auto" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto"}`}
      >
        <div className="relative w-full h-5 flex items-center group/timeline">
          <input
            type="range"
            min={0}
            max={seekMax}
            step={0.1}
            value={seekValue}
            aria-label="Tua video"
            aria-disabled={duration <= 0}
            onChange={(e) => onSeekChange(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-white aria-disabled:cursor-not-allowed aria-disabled:opacity-50 focus:outline-none transition-all duration-200 group-hover/timeline:h-2"
            style={{ background: trackBackground }}
          />
          {duration > 0 && interactions.map((it) => {
            if (it.startSeconds > duration) return null;
            const pct = (it.startSeconds / duration) * 100;
            const markerBgMap: Record<number, string> = {
              [InteractionKind.SINGLE_CHOICE]: "bg-rose-400 hover:bg-rose-500 ring-rose-400/30",
              [InteractionKind.MULTIPLE_CHOICE]: "bg-purple-400 hover:bg-purple-500 ring-purple-400/30",
              [InteractionKind.FILL_BLANK]: "bg-emerald-400 hover:bg-emerald-500 ring-emerald-400/30",
              [InteractionKind.LISTENING]: "bg-amber-400 hover:bg-amber-500 ring-amber-400/30",
              [InteractionKind.READING]: "bg-sky-400 hover:bg-sky-500 ring-sky-400/30",
            };
            const kindLabelMap: Record<number, string> = {
              [InteractionKind.SINGLE_CHOICE]: "Trắc nghiệm 1 đáp án",
              [InteractionKind.MULTIPLE_CHOICE]: "Trắc nghiệm chọn nhiều",
              [InteractionKind.FILL_BLANK]: "Điền đáp án",
              [InteractionKind.LISTENING]: "Bài nghe",
              [InteractionKind.READING]: "Bài đọc",
            };
            const markerBg = markerBgMap[it.kind] ?? "bg-white hover:bg-zinc-200 ring-white/30";
            const kindLabel = kindLabelMap[it.kind] ?? "Bài tập";

            return (
              <div
                key={it.id}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group/marker z-50 cursor-pointer pointer-events-auto"
                style={{ left: `${pct}%` }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeekChange(it.startSeconds);
                }}
              >
                <span className={`block size-2.5 rounded-full border border-black/50 shadow ${markerBg} transition-transform duration-200 hover:scale-135 hover:ring-4`} />
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/90 backdrop-blur-md text-[10px] text-white px-2 py-1 rounded shadow-lg border border-white/10 opacity-0 group-hover/marker:opacity-100 pointer-events-none transition-opacity duration-200 whitespace-nowrap z-50 flex flex-col gap-0.5 min-w-[120px] select-none text-left">
                  <span className="font-bold text-[9px] uppercase tracking-wider text-primary">{kindLabel}</span>
                  <span className="truncate max-w-[160px] font-medium text-white/95">{it.prompt || "Nhấn để xem chi tiết"}</span>
                  <span className="text-[8px] text-zinc-400 font-mono mt-0.5">Thời điểm: {formatTime(it.startSeconds)}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between text-white text-sm font-medium select-none">
          <div className="flex items-center gap-4">
            <button
              type="button"
              aria-label={paused ? "Phát video" : "Tạm dừng video"}
              onClick={onTogglePlay}
              className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
            >
              {!paused ? <Pause className="size-5 fill-white" /> : <Play className="size-5 fill-white" />}
            </button>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={muted || volume === 0 ? "Bật âm thanh" : "Tắt âm thanh"}
                onClick={onToggleMute}
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
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                className="w-16 opacity-100 h-1 bg-white/20 rounded-md appearance-none cursor-pointer accent-white hover:bg-white/40 transition-all duration-150"
              />
            </div>

            <span className="text-xs text-zinc-300 font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {allowFullscreen && (
            <button
              type="button"
              aria-label={isFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}
              onClick={onToggleFullscreen}
              className="hover:scale-110 active:scale-95 transition-all duration-200 focus:outline-none"
            >
              {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
