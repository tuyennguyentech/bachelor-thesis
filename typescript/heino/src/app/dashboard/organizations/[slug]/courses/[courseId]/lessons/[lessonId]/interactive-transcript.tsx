"use client";

import React, { useEffect, useRef, useState, useCallback, memo } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";

interface Props {
  segments: TranscriptSegment[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface ButtonProps {
  seg: TranscriptSegment;
  isActive: boolean;
  onClick: (seg: TranscriptSegment) => void;
  buttonRef: (el: HTMLButtonElement | null, idx: number) => void;
  index: number;
}

const TranscriptSegmentButton = memo(
  ({ seg, isActive, onClick, buttonRef, index }: ButtonProps) => {
    return (
      <button
        ref={(el) => buttonRef(el, index)}
        onClick={() => onClick(seg)}
        data-testid={`transcript-segment-${index}`}
        data-start-seconds={seg.startSeconds}
        className={`text-left w-full rounded px-2 py-1.5 text-sm transition-colors ${
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:bg-muted/60"
        }`}
      >
        <span className="font-mono text-xs mr-2 opacity-60">
          {formatTime(seg.startSeconds)}
        </span>
        {seg.text}
      </button>
    );
  }
);
TranscriptSegmentButton.displayName = "TranscriptSegmentButton";

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

  // Auto-scroll active segment into view locally inside containerRef without scrolling the main page
  useEffect(() => {
    if (activeIndex >= 0 && segmentRefs.current[activeIndex] && containerRef.current) {
      const container = containerRef.current;
      const element = segmentRefs.current[activeIndex]!;

      const containerTop = container.scrollTop;
      const containerBottom = containerTop + container.clientHeight;

      const elemTop = element.offsetTop;
      const elemBottom = elemTop + element.clientHeight;

      if (elemTop < containerTop) {
        container.scrollTo({ top: elemTop, behavior: "smooth" });
      } else if (elemBottom > containerBottom) {
        container.scrollTo({ top: elemBottom - container.clientHeight, behavior: "smooth" });
      }
    }
  }, [activeIndex]);

  const handleSeek = useCallback(
    (seg: TranscriptSegment) => {
      if (videoRef.current) {
        videoRef.current.currentTime = seg.startSeconds;
        videoRef.current.play().catch(() => {});
      }
    },
    [videoRef]
  );

  const setSegmentRef = useCallback((el: HTMLButtonElement | null, idx: number) => {
    segmentRefs.current[idx] = el;
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="interactive-transcript"
      className="max-h-72 overflow-y-auto flex flex-col gap-0.5 pr-1"
    >
      {segments.map((seg, i) => (
        <TranscriptSegmentButton
          key={i}
          seg={seg}
          isActive={i === activeIndex}
          onClick={handleSeek}
          buttonRef={setSegmentRef}
          index={i}
        />
      ))}
    </div>
  );
}
