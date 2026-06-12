import type { ChunkScoreCell } from "buf/gen/richter/v1/interactions_pb";
import { AlertTriangleIcon } from "lucide-react";

interface Props {
  cells: ChunkScoreCell[];
}

/** Format seconds as mm:ss. */
function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Tailwind background class for a chunk's average score (0..1). */
function scoreBg(avgScore: number, responseCount: number): string {
  if (responseCount === 0) return "bg-muted";
  if (avgScore >= 0.8) return "bg-green-500/70";
  if (avgScore >= 0.5) return "bg-amber-500/70";
  return "bg-red-500/70";
}

/**
 * Horizontal score heatmap across a lesson's chunks. Each segment's width is
 * proportional to its duration; its colour reflects the average score. Gap
 * chunks (low engagement/score) are ringed in red and flagged with a warning.
 */
export function LessonHeatmap({ cells }: Props) {
  if (cells.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Chưa đủ dữ liệu để dựng bản đồ nhiệt theo phân đoạn.
      </p>
    );
  }

  const ordered = [...cells].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const durations = ordered.map((c) => Math.max(0.001, c.endSeconds - c.startSeconds));
  const totalDuration = durations.reduce((acc, d) => acc + d, 0);

  return (
    <div className="flex flex-col gap-3" data-testid="lesson-heatmap">
      <div className="flex w-full items-stretch gap-1">
        {ordered.map((cell, i) => {
          const widthPct = (durations[i] / totalDuration) * 100;
          const pct = cell.responseCount > 0 ? Math.round(cell.avgScore * 100) : 0;
          const title = `Đoạn ${cell.chunkIndex + 1} · ${pct}% · ${cell.responseCount} lượt`;
          return (
            <div
              key={cell.chunkId || cell.chunkIndex}
              className="flex min-w-[28px] flex-col items-center gap-1"
              style={{ width: `${widthPct}%` }}
            >
              <div
                title={title}
                className={`relative flex h-10 w-full items-center justify-center rounded ${scoreBg(
                  cell.avgScore,
                  cell.responseCount,
                )} ${cell.isGap ? "ring-2 ring-red-600" : ""}`}
              >
                {cell.isGap && (
                  <AlertTriangleIcon className="size-4 text-red-700 dark:text-red-300" />
                )}
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatMmSs(cell.startSeconds)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded bg-green-500/70" /> ≥ 80%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded bg-amber-500/70" /> 50–79%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded bg-red-500/70" /> &lt; 50%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded bg-muted" /> Chưa có dữ liệu
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded ring-2 ring-red-600" /> Điểm khó (cần chú ý)
        </span>
      </div>
    </div>
  );
}
