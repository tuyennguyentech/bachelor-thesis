"use client";

import { useState } from "react";
import { FileTextIcon, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { TranscriptSegment, TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import { InteractiveTranscript } from "./interactive-transcript";

interface Props {
  chunks: TranscriptChunk[];
  segments: TranscriptSegment[];
  transcript: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

type Tab = "outline" | "transcript";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function seekTo(seconds: number, videoRef: React.RefObject<HTMLVideoElement | null>) {
  // Direct path: video element is local.
  const video = videoRef.current;
  if (video) {
    try {
      video.currentTime = seconds;
      video.play().catch(() => {});
    } catch {}
    return;
  }
  // Cross-component path: dispatch a window event so VideoPlayer can react
  // even when the video element lives in a sibling tree.
  window.dispatchEvent(new CustomEvent("seek-video", { detail: { seconds } }));
}

export function LessonSidebar({ chunks, segments, transcript, videoRef }: Props) {
  const hasOutline = chunks.length > 0;
  const hasTranscript = segments.length > 0 || !!transcript;
  const defaultTab: Tab = hasOutline ? "outline" : "transcript";
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [collapsed, setCollapsed] = useState(false);

  if (!hasOutline && !hasTranscript) return null;

  return (
    <div className="rounded-md border overflow-hidden flex flex-col">
      {/* Tab header + collapse toggle */}
      <div className="flex items-center border-b bg-muted/30">
        {hasOutline && (
          <button
            type="button"
            onClick={() => setTab("outline")}
            className={[
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              tab === "outline"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <BookOpenIcon className="size-3.5" />
            Dàn bài
          </button>
        )}
        {hasTranscript && (
          <button
            type="button"
            onClick={() => setTab("transcript")}
            className={[
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              tab === "transcript"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <FileTextIcon className="size-3.5" />
            Phiên âm
          </button>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="ml-auto p-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={collapsed ? "Mở rộng" : "Thu gọn"}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronLeftIcon className="size-3.5" />
          )}
        </button>
      </div>

      {!collapsed && (
        <div className={`max-h-[calc(100vh-200px)] ${tab === "outline" || segments.length === 0 ? "overflow-y-auto" : ""}`}>
          {tab === "outline" && hasOutline && (
            <div className="flex flex-col divide-y divide-border/50 p-2">
              {chunks.map((chunk) => (
                <button
                  key={chunk.id}
                  type="button"
                  onClick={() => seekTo(chunk.startSeconds, videoRef)}
                  className="flex flex-col gap-0.5 py-2 px-1 text-left rounded-md hover:bg-muted/50 focus:bg-muted/60 focus:outline-none transition-colors"
                  data-testid={`outline-chunk-${chunk.id}`}
                  data-start-seconds={chunk.startSeconds}
                  aria-label={`Nhảy tới đoạn ${chunk.summary} tại ${formatTime(chunk.startSeconds)}`}
                >
                  <p className="text-xs font-medium text-foreground line-clamp-2">
                    {chunk.summary}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatTime(chunk.startSeconds)} – {formatTime(chunk.endSeconds)}
                  </p>
                </button>
              ))}
            </div>
          )}

          {tab === "transcript" && hasTranscript && (
            <div className="p-3">
              {segments.length > 0 ? (
                <InteractiveTranscript segments={segments} videoRef={videoRef} maxHeightClass="max-h-[calc(100vh-260px)] lg:max-h-[calc(100vh-220px)]" />
              ) : (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {transcript}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
