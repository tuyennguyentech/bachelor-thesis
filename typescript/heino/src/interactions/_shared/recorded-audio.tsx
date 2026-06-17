"use client";

import { useEffect, useRef, useState } from "react";
import { PlayIcon, PauseIcon } from "lucide-react";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * Player for MediaRecorder-produced recordings (student voice answers).
 *
 * MediaRecorder writes webm/ogg in STREAMING mode with no duration in the
 * container header, so a native <audio controls> reports `duration === Infinity`
 * → the seek bar jumps straight to the end and shows no total time (the reported
 * bug). The common "seek past the end" workaround is unreliable in Firefox for
 * cue-less webm. Instead we decode the clip with AudioContext.decodeAudioData,
 * which yields an accurate duration in every browser, and drive a small custom
 * transport (play/pause + seek bar + time) from it.
 */
export function RecordedAudio({
  src,
  className,
  testId,
}: {
  src: string;
  className?: string;
  testId?: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Callers pass key={src} so a new recording remounts this component and resets
  // duration/current/playing — that's why this effect only sets state AFTER the
  // async decode (no synchronous setState in the effect body).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        const Ctx: typeof AudioContext =
          window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const decoded = await ctx.decodeAudioData(buf);
        await ctx.close();
        if (!cancelled && Number.isFinite(decoded.duration) && decoded.duration > 0) {
          setDuration(decoded.duration);
        }
      } catch {
        // decode failed (e.g. unsupported codec) — fall back to whatever the
        // native element exposes once it loads metadata.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  const onNativeMeta = () => {
    const d = audioRef.current?.duration;
    if (d && Number.isFinite(d) && d > 0 && duration === 0) setDuration(d);
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  const seek = (t: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = t;
    setCurrent(t);
  };

  return (
    <div
      className={`flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 ${className ?? ""}`}
      data-testid={testId}
      data-duration={duration}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Tạm dừng" : "Phát"}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
      >
        {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
      </button>
      <span className="text-xs tabular-nums text-muted-foreground">{fmt(current)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step="0.01"
        value={Math.min(current, duration || 0)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Tua bản ghi"
        className="h-1.5 flex-1 cursor-pointer accent-primary"
        disabled={!duration}
      />
      <span className="text-xs tabular-nums text-muted-foreground" data-testid="recording-total-time">
        {fmt(duration)}
      </span>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onNativeMeta}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
