"use client";

import React, { useEffect, useRef, useState, useCallback, memo, useMemo } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { SearchIcon, CopyIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { uploadConfig } from "@/lib/client-config";

interface Props {
  segments: TranscriptSegment[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  maxHeightClass?: string;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface ButtonProps {
  seg: TranscriptSegment;
  isActive: boolean;
  searchQuery: string;
  onClick: (seg: TranscriptSegment) => void;
  buttonRef: (el: HTMLButtonElement | null, idx: number) => void;
  index: number;
}

const TranscriptSegmentButton = memo(
  ({ seg, isActive, searchQuery, onClick, buttonRef, index }: ButtonProps) => {
    // Dynamically highlight matching search queries inside the text
    const textContent = useMemo(() => {
      const query = searchQuery.trim();
      if (!query) return seg.text;
      const regex = new RegExp(`(${query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")})`, "i");
      const parts = seg.text.split(regex);
      return parts.map((part, i) =>
        part.toLocaleLowerCase() === query.toLocaleLowerCase() ? (
          <mark key={i} className="bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 rounded px-0.5 font-semibold">
            {part}
          </mark>
        ) : (
          part
        )
      );
    }, [seg.text, searchQuery]);

    return (
      <button
        ref={(el) => buttonRef(el, index)}
        onClick={() => onClick(seg)}
        data-testid={`transcript-segment-${index}`}
        data-start-seconds={seg.startSeconds}
        className={`text-left w-full rounded-lg px-3 py-2 text-sm transition-all duration-300 relative border ${
          isActive
            ? "bg-primary/10 border-primary/20 text-primary font-semibold shadow-[0_0_10px_rgba(59,130,246,0.15)] dark:shadow-[0_0_10px_rgba(59,130,246,0.08)] scale-[1.01]"
            : "text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground"
        }`}
      >
        {isActive && (
          <span className="absolute top-0 left-0 w-1 h-full bg-primary rounded-r-md" />
        )}
        <span className="font-mono text-xs mr-2 opacity-50 select-none bg-muted px-1.5 py-0.5 rounded">
          {formatTime(seg.startSeconds)}
        </span>
        <span className="leading-relaxed">{textContent}</span>
      </button>
    );
  }
);
TranscriptSegmentButton.displayName = "TranscriptSegmentButton";

export function InteractiveTranscript({ segments, videoRef, maxHeightClass = "max-h-72" }: Props) {
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isAutoFollow, setIsAutoFollow] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const pauseAutoFollow = useCallback(() => {
    setIsAutoFollow(false);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Use passive timeupdate updates to keep active segments in sync
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

  // Keep playback-follow local to the transcript panel and never re-enable it
  // implicitly after the teacher/student manually scrolls the transcript.
  useEffect(() => {
    if (
      isAutoFollow &&
      !isHovered &&
      !searchQuery.trim() &&
      activeIndex >= 0 &&
      segmentRefs.current[activeIndex] &&
      containerRef.current
    ) {
      const element = segmentRefs.current[activeIndex]!;
      const container = containerRef.current;

      const targetScrollTop = element.offsetTop - (container.clientHeight / 2) + (element.clientHeight / 2);

      container.scrollTo({
        top: targetScrollTop,
        behavior: "smooth"
      });
    }
  }, [activeIndex, isAutoFollow, isHovered, searchQuery]);

  const handleSeek = useCallback(
    (seg: TranscriptSegment) => {
      if (videoRef.current) {
        videoRef.current.currentTime = seg.startSeconds;
        videoRef.current.play().catch(() => {});
        setIsAutoFollow(true);
      }
    },
    [videoRef]
  );

  const setSegmentRef = useCallback((el: HTMLButtonElement | null, idx: number) => {
    segmentRefs.current[idx] = el;
  }, []);

  const copyFullTranscript = async () => {
    const fullText = segments.map(s => `[${formatTime(s.startSeconds)}] ${s.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      toast.success("Đã copy toàn bộ transcript vào clipboard!");
      setTimeout(() => setCopied(false), uploadConfig.copyToastMs);
    } catch {
      toast.error("Không thể copy transcript");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Search and Action Bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="search"
              placeholder="Tìm từ khóa trong transcript..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsAutoFollow(false);
              }}
              className="w-full text-xs rounded-md border border-input/60 bg-background/50 pl-8 pr-2.5 py-1.5 text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-primary focus:outline-none transition-all"
            />
          </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copyFullTranscript}
          className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
        >
          {copied ? <CheckIcon className="size-3.5 text-green-500" /> : <CopyIcon className="size-3.5" />}
          Copy
        </Button>
      </div>

      {/* Transcript Scroll Area */}
      <div
        ref={containerRef}
        data-testid="interactive-transcript"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onWheel={pauseAutoFollow}
        onTouchMove={pauseAutoFollow}
        onKeyDown={pauseAutoFollow}
        className={`relative overflow-y-auto flex flex-col gap-1 pr-1 border border-border/20 rounded-lg p-1.5 bg-muted/5 shadow-inner w-full ${maxHeightClass}`}
      >
        {segments.map((seg, i) => (
          <TranscriptSegmentButton
            key={i}
            seg={seg}
            isActive={i === activeIndex}
            searchQuery={searchQuery}
            onClick={handleSeek}
            buttonRef={setSegmentRef}
            index={i}
          />
        ))}
      </div>
    </div>
  );
}
