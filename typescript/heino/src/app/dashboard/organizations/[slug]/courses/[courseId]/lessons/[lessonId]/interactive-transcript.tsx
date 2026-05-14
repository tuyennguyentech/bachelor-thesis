"use client";

import { useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";

interface Props {
  segments: TranscriptSegment[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export function InteractiveTranscript({ segments, videoRef }: Props) {
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function onTimeUpdate() {
      const t = video!.currentTime;
      let next = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (t >= segments[i].startSeconds) {
          next = i;
          break;
        }
      }
      setActiveIndex(next);
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef, segments]);

  // Auto-scroll active segment into view
  useEffect(() => {
    if (activeIndex >= 0 && segmentRefs.current[activeIndex]) {
      segmentRefs.current[activeIndex]!.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeIndex]);

  function seekTo(seg: TranscriptSegment) {
    if (videoRef.current) {
      videoRef.current.currentTime = seg.startSeconds;
      videoRef.current.play();
    }
  }

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <div
      ref={containerRef}
      className="max-h-72 overflow-y-auto flex flex-col gap-0.5 pr-1"
    >
      {segments.map((seg, i) => (
        <button
          key={i}
          ref={(el) => { segmentRefs.current[i] = el; }}
          onClick={() => seekTo(seg)}
          className={`text-left w-full rounded px-2 py-1.5 text-sm transition-colors ${
            i === activeIndex
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:bg-muted/60"
          }`}
        >
          <span className="font-mono text-xs mr-2 opacity-60">
            {formatTime(seg.startSeconds)}
          </span>
          {seg.text}
        </button>
      ))}
    </div>
  );
}
