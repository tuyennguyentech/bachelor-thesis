"use client";

import { useState } from "react";
import type {
  ChunkScoreCell,
  ChunkStudentBreakdown,
  ChunkStudentScore,
  QuestionStat,
} from "buf/gen/richter/v1/interactions_pb";
import { AlertTriangleIcon, XIcon } from "lucide-react";

interface Props {
  cells: ChunkScoreCell[];
  /** Per-chunk student breakdowns for the click-to-expand drill-down. */
  breakdowns?: ChunkStudentBreakdown[];
  /**
   * Per-question stats, used as a fallback heatmap when the lesson has no
   * transcript chunks (so there are no chunk cells) but students have answered.
   */
  questions?: QuestionStat[];
  /** True when the heatmap RPC failed (distinct from "no data yet"). */
  error?: boolean;
}

/** Format seconds as mm:ss. */
function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface HeatCell {
  key: string;
  widthPct: number;
  pct: number;
  hasData: boolean;
  isGap: boolean;
  bottom: string;
  tip: { title: string; rows: { label: string; value: string }[]; note?: string };
  /** Title for the drill-down panel (segment name). */
  drillTitle: string;
  /** Students who answered this cell's questions (only for segment cells). */
  students?: ChunkStudentScore[];
}

/** Solid band colour for a cell's score/accuracy percent. */
function cellBg(c: HeatCell): string {
  if (!c.hasData) return "bg-muted";
  if (c.pct >= 80) return "bg-emerald-500";
  if (c.pct >= 50) return "bg-amber-500";
  return "bg-red-500";
}

/** Text colour for a 0..1 score fraction (matches the cell bands). */
function fracText(frac: number): string {
  if (frac >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (frac >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Shared colour legend below either heatmap variant. */
function HeatmapLegend({ gapLabel, clickable }: { gapLabel: string; clickable: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded bg-emerald-500" /> ≥ 80%
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded bg-amber-500" /> 50–79%
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded bg-red-500" /> &lt; 50%
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded bg-muted" /> Chưa có dữ liệu
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded ring-2 ring-red-500" /> {gapLabel}
      </span>
      <span className="text-muted-foreground/70">
        {clickable ? "Di chuột để xem nhanh, BẤM vào ô để xem danh sách học viên" : "Di chuột vào ô để xem chi tiết"}
      </span>
    </div>
  );
}

/** The list of students under a clicked segment cell, sorted weakest-first. */
function SegmentDrillDown({ cell, onClose }: { cell: HeatCell; onClose: () => void }) {
  const students = [...(cell.students ?? [])].sort((a, b) => a.scoreFrac - b.scoreFrac);
  return (
    <div className="rounded-md border bg-muted/20" data-testid="heatmap-drilldown">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">
          {cell.drillTitle} ·{" "}
          <span className="tabular-nums text-muted-foreground">{students.length} học viên</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Đóng"
          data-testid="heatmap-drilldown-close"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {students.length === 0 ? (
        <p className="px-3 py-4 text-center text-sm text-muted-foreground">
          Chưa có học viên nào trả lời phân đoạn này.
        </p>
      ) : (
        <div className="divide-y">
          {students.map((s) => {
            const pct = Math.round(s.scoreFrac * 100);
            return (
              <div key={s.userId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.displayName || s.userId}</div>
                  {s.email && <div className="truncate text-xs text-muted-foreground">{s.email}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-4 text-xs tabular-nums">
                  <span className="text-muted-foreground">{s.answered} câu</span>
                  <span className={`font-semibold ${fracText(s.scoreFrac)}`}>{pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Interactive heatmap row shared by the segment + per-question variants. */
function HeatmapRow({ cells, gapLabel }: { cells: HeatCell[]; gapLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const drillable = cells.some((c) => c.students !== undefined);
  // Cumulative centre (% of row width) of each cell, for tooltip positioning.
  let acc = 0;
  const centers = cells.map((c) => {
    const center = acc + c.widthPct / 2;
    acc += c.widthPct;
    return center;
  });

  return (
    <div className="flex flex-col gap-3" data-testid="lesson-heatmap">
      <div className="relative">
        <div className="flex w-full items-stretch gap-1">
          {cells.map((c, i) => {
            const active = hover === i;
            const isSel = selected === i;
            const canDrill = c.students !== undefined;
            return (
              <div
                key={c.key}
                data-testid="heatmap-cell"
                data-cell-index={i}
                style={{ width: `${c.widthPct}%` }}
                className="flex min-w-[34px] flex-col items-center gap-1.5"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => canDrill && setSelected((s) => (s === i ? null : i))}
              >
                <div
                  className={`relative flex h-14 w-full ${canDrill ? "cursor-pointer" : "cursor-default"} items-center justify-center rounded-md text-xs font-semibold text-white transition-all ${cellBg(
                    c,
                  )} ${
                    isSel
                      ? "-translate-y-0.5 shadow-md ring-2 ring-foreground"
                      : active
                        ? "-translate-y-0.5 shadow-md ring-2 ring-foreground/60"
                        : c.isGap
                          ? "ring-2 ring-red-500/80"
                          : ""
                  }`}
                >
                  {c.hasData ? `${c.pct}%` : <span className="text-muted-foreground">–</span>}
                  {c.isGap && (
                    <span className="absolute right-1 top-1">
                      <AlertTriangleIcon className="size-3.5 text-white drop-shadow" />
                    </span>
                  )}
                </div>
                <span className="w-full truncate text-center text-[10px] tabular-nums text-muted-foreground">
                  {c.bottom}
                </span>
              </div>
            );
          })}
        </div>

        {hover !== null && cells[hover] && (
          <div
            className="pointer-events-none absolute bottom-full z-20 -translate-x-1/2 pb-2"
            style={{ left: `${Math.max(12, Math.min(88, centers[hover]))}%` }}
          >
            <div className="w-56 rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
              <div className="font-medium">{cells[hover].tip.title}</div>
              <div className="mt-1 flex flex-col gap-0.5">
                {cells[hover].tip.rows.map((r) => (
                  <div key={r.label} className="flex justify-between gap-3 tabular-nums">
                    <span className="text-muted-foreground">{r.label}</span>
                    <span className="font-medium text-foreground">{r.value}</span>
                  </div>
                ))}
              </div>
              {cells[hover].tip.note && (
                <p className="mt-1.5 line-clamp-3 border-t pt-1.5 leading-snug text-muted-foreground">
                  {cells[hover].tip.note}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <HeatmapLegend gapLabel={gapLabel} clickable={drillable} />

      {selected !== null && cells[selected]?.students !== undefined && (
        <SegmentDrillDown cell={cells[selected]} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/**
 * Horizontal score heatmap. With transcript chunks, each segment's width is
 * proportional to its duration and its colour reflects the average score. With
 * no chunks, falls back to an equal-width per-question heatmap. Hovering any cell
 * reveals its detail (time/summary or prompt, score, respondents); clicking a
 * segment cell expands the list of students who answered it.
 */
export function LessonHeatmap({ cells, breakdowns, questions, error }: Props) {
  if (error) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="heatmap-empty">
        Không tải được bản đồ nhiệt. Hãy thử tải lại trang.
      </p>
    );
  }

  const hasChunkData = cells.length > 0 && cells.some((c) => c.responseCount > 0);
  const answeredQuestions = (questions ?? []).filter((q) => q.responseCount > 0);

  // No chunk-level scores yet — fall back to a per-question heatmap if students
  // have answered, otherwise explain why there's nothing to show.
  if (!hasChunkData) {
    if (answeredQuestions.length > 0) {
      const qCells: HeatCell[] = answeredQuestions.map((q, i) => {
        const pct = Math.round(q.accuracy * 100);
        return {
          key: q.interactionId,
          widthPct: 100 / answeredQuestions.length,
          pct,
          hasData: true,
          isGap: q.accuracy < 0.6,
          bottom: `Câu ${i + 1}`,
          drillTitle: `Câu ${i + 1}`,
          tip: {
            title: `Câu ${i + 1}`,
            rows: [
              { label: "Tỉ lệ đúng", value: `${pct}%` },
              { label: "Lượt trả lời", value: String(q.responseCount) },
            ],
            note: q.prompt || undefined,
          },
        };
      });
      return <HeatmapRow cells={qCells} gapLabel="Câu khó (cần chú ý)" />;
    }
    if (cells.length === 0) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="heatmap-empty">
          Chưa có học viên nào trả lời nên bản đồ nhiệt chưa có dữ liệu.
        </p>
      );
    }
    return (
      <p className="text-sm text-muted-foreground" data-testid="heatmap-empty">
        Đã phân đoạn nhưng chưa có học viên nào trả lời, nên bản đồ nhiệt chưa có dữ
        liệu điểm.
      </p>
    );
  }

  // chunkId → students, so each segment cell can expand into its answerers.
  const studentsByChunk = new Map<string, ChunkStudentScore[]>();
  for (const b of breakdowns ?? []) studentsByChunk.set(b.chunkId, b.students);

  const ordered = [...cells].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const durations = ordered.map((c) => Math.max(0.001, c.endSeconds - c.startSeconds));
  const totalDuration = durations.reduce((acc, d) => acc + d, 0);

  const segCells: HeatCell[] = ordered.map((c, i) => {
    const pct = c.responseCount > 0 ? Math.round(c.avgScore * 100) : 0;
    const title = `Đoạn ${c.chunkIndex + 1} · ${formatMmSs(c.startSeconds)}–${formatMmSs(c.endSeconds)}`;
    return {
      key: c.chunkId || String(c.chunkIndex),
      widthPct: (durations[i] / totalDuration) * 100,
      pct,
      hasData: c.responseCount > 0,
      isGap: c.isGap,
      bottom: formatMmSs(c.startSeconds),
      drillTitle: title,
      students: studentsByChunk.get(c.chunkId) ?? [],
      tip: {
        title,
        rows: [
          { label: "Điểm TB", value: c.responseCount > 0 ? `${pct}%` : "—" },
          { label: "Lượt trả lời", value: String(c.responseCount) },
          { label: "Học viên", value: String(c.studentCount) },
        ],
        note: c.summary || undefined,
      },
    };
  });

  return <HeatmapRow cells={segCells} gapLabel="Điểm khó (cần chú ý)" />;
}
