"use client";

import { Button } from "@/components/ui/button";
import type { TranscriptChunk, TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Loader2Icon,
  MergeIcon,
  PlayIcon,
  ScissorsIcon,
  Trash2Icon,
} from "lucide-react";
import { formatTime } from "@/lib/format";

export function getChunkSegments(chunk: TranscriptChunk, allSegments: TranscriptSegment[]): TranscriptSegment[] {
  return allSegments.filter(s =>
    s.startSeconds >= chunk.startSeconds &&
    s.startSeconds < chunk.endSeconds
  );
}

function CoherenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 35
    ? "text-green-700 dark:text-green-400 border-green-300 dark:border-green-800"
    : pct >= 20
      ? "text-yellow-700 dark:text-yellow-400 border-yellow-300 dark:border-yellow-800"
      : "text-red-700 dark:text-red-400 border-red-300 dark:border-red-800";
  return (
    <span
      data-testid="coherence-badge"
      data-score={pct}
      className={`text-xs border rounded px-1.5 py-px font-mono ${color}`}
      title="Mức độ gắn kết nội dung (tỉ lệ từ trong mỗi câu thuộc về vốn từ chủ đề chung của đoạn)"
    >
      {pct}%
    </span>
  );
}

interface ChunkEditorProps {
  chunk: TranscriptChunk;
  chunkSegments: TranscriptSegment[];
  prevChunkId: string | null;
  nextChunkId: string | null;
  onMergeWithPrev: (id: string) => void;
  onMergeWithNext: (id: string) => void;
  onDelete: (id: string) => void;
  onSplit: (id: string, splitAtSeconds: number) => void;
  onMoveSegment: (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) => void;
  isMerging: boolean;
  isDeleting: boolean;
  isSplitting: boolean;
  isMoving: boolean;
  disabled: boolean;
}

export function ChunkEditor({
  chunk, chunkSegments, prevChunkId, nextChunkId,
  onMergeWithPrev, onMergeWithNext, onDelete, onSplit, onMoveSegment,
  isMerging, isDeleting, isSplitting, isMoving, disabled,
}: ChunkEditorProps) {
  const busy = disabled || isMerging || isDeleting || isSplitting || isMoving;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/20 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-muted/40 cursor-pointer hover:bg-muted/60 transition-colors group"
        onClick={() => {
          const ev = new CustomEvent("seek-video", { detail: { seconds: chunk.startSeconds } });
          window.dispatchEvent(ev);
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <PlayIcon className="size-3 text-primary shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" />
            <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">{chunk.summary}</p>
          </div>
          <p className="text-xs text-muted-foreground">{formatTime(chunk.startSeconds)} - {formatTime(chunk.endSeconds)}</p>
        </div>
        {chunkSegments.length > 0 && <CoherenceBadge score={chunk.coherenceScore} />}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {prevChunkId && (
            <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs h-6"
              disabled={busy} onClick={(e) => { e.stopPropagation(); onMergeWithPrev(chunk.id); }} title="Gộp với đoạn trước">
              {isMerging ? <Loader2Icon className="size-3 animate-spin" /> : <MergeIcon className="size-3" />}
              Gộp lên
            </Button>
          )}
          {nextChunkId && (
            <Button variant="ghost" size="sm" className="gap-1 px-2 text-xs h-6"
              disabled={busy} onClick={(e) => { e.stopPropagation(); onMergeWithNext(chunk.id); }} title="Gộp với đoạn sau">
              {isMerging ? <Loader2Icon className="size-3 animate-spin" /> : <MergeIcon className="size-3" />}
              Gộp xuống
            </Button>
          )}
          <Button variant="ghost" size="sm"
            className="gap-1 px-2 text-xs h-6 text-destructive hover:text-destructive"
            disabled={busy} onClick={(e) => { e.stopPropagation(); onDelete(chunk.id); }}>
            {isDeleting ? <Loader2Icon className="size-3 animate-spin" /> : <Trash2Icon className="size-3" />}
            Xoá
          </Button>
        </div>
      </div>
      {chunkSegments.length > 0 && (
        <div className="flex flex-col divide-y divide-border/50 px-1 pb-1">
          {chunkSegments.map((seg, i) => {
            const isFirstSeg = i === 0;
            const isLastSeg = i === chunkSegments.length - 1;
            const nextSegStart = !isLastSeg ? chunkSegments[i + 1].startSeconds : null;
            return (
              <div
                key={seg.startSeconds}
                className="flex items-start gap-2 px-2 py-1.5 text-xs group cursor-pointer hover:bg-muted/10 transition-colors rounded-sm"
                onClick={() => {
                  const ev = new CustomEvent("seek-video", { detail: { seconds: seg.startSeconds } });
                  window.dispatchEvent(ev);
                }}
              >
                <span className="text-muted-foreground tabular-nums shrink-0 pt-0.5">{formatTime(seg.startSeconds)}</span>
                <p className="flex-1 text-foreground leading-relaxed">{seg.text}</p>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {isFirstSeg && prevChunkId && !isLastSeg && (
                    <Button variant="ghost" size="sm"
                      className="px-1 text-xs h-5"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); onMoveSegment(prevChunkId, chunk.id, nextSegStart ?? chunk.endSeconds, chunk.id); }}
                      title="Chuyển lên đoạn trước">
                      {isMoving ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowUpIcon className="size-3" />}
                    </Button>
                  )}
                  {isLastSeg && nextChunkId && (
                    <Button variant="ghost" size="sm"
                      className="px-1 text-xs h-5"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); onMoveSegment(chunk.id, nextChunkId, seg.startSeconds, chunk.id); }}
                      title="Chuyển xuống đoạn sau">
                      {isMoving ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowDownIcon className="size-3" />}
                    </Button>
                  )}
                  {!isFirstSeg && (
                    <Button variant="ghost" size="sm"
                      className="gap-1 px-1.5 text-xs h-5"
                      disabled={busy} onClick={(e) => { e.stopPropagation(); onSplit(chunk.id, seg.startSeconds); }}
                      title="Tách chunk tại đây">
                      {isSplitting ? <Loader2Icon className="size-3 animate-spin" /> : <ScissorsIcon className="size-3" />}
                      Tách
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
