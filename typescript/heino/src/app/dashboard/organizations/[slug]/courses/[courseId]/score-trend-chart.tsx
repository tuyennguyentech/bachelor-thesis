"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Interactive per-lesson score-trend chart for the student progress card.
 *
 * Replaces the old bare sparkline (two unlabelled dashed lines + dots whose only
 * tooltip was a native <title> that never showed): a proper line chart with a
 * labelled Y axis (0 / 50 / 80 / 100 %), so the threshold guides actually mean
 * something; per-point value labels so the level is readable at a glance; and a
 * real positioned hover tooltip (lesson name + exact score), matching the course
 * results charts.
 */

export interface ScoreTrendPoint {
  /** Score as a 0..1 fraction. */
  frac: number;
  /** Lesson id — used to navigate to the lesson on click. */
  lessonId: string;
  /** Lesson name (shown in the tooltip). */
  lessonTitle: string;
  /** Lesson number — its 1-based position within its chapter (e.g. "Bài 3"). 0 if unknown. */
  lessonNumber: number;
  /** Chapter (module) name the lesson belongs to (shown in the tooltip). */
  moduleTitle: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function tierFill(pct: number): string {
  if (pct >= 80) return "fill-emerald-500";
  if (pct >= 50) return "fill-amber-500";
  return "fill-red-500";
}
function tierText(pct: number): string {
  if (pct >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function ScoreTrendChart({
  points,
  slug,
  courseId,
  learnMode = false,
}: {
  points: ScoreTrendPoint[];
  slug: string;
  courseId: string;
  learnMode?: boolean;
}) {
  const router = useRouter();
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  // Carry mode=learn so a manager previewing as a student stays in the learner
  // view after navigating to the lesson (mirrors the card's lessonHref).
  const lessonHref = (lessonId: string) =>
    `/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}${learnMode ? "?mode=learn" : ""}`;

  const W = 640;
  const H = 188;
  const M = { l: 34, r: 14, t: 18, b: 30 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const n = points.length;
  const xOf = (i: number) => M.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const yOf = (frac: number) => M.t + (1 - clamp(frac, 0, 1)) * ph;

  // Show a value label over each point only when the series is short enough that
  // they won't collide; past that, the Y axis + hover tooltip carry the reading.
  const showValueLabels = n <= 8;
  // Thin out x-axis order numbers for long series.
  const xLabelEvery = n <= 12 ? 1 : Math.ceil(n / 10);

  const linePts = points.map((p, i) => `${xOf(i)},${yOf(p.frac)}`).join(" ");
  const areaPts = `${M.l},${M.t + ph} ${linePts} ${M.l + pw},${M.t + ph}`;

  // Y gridlines: plain at 0/100, themed threshold guides at 50 (amber) and 80 (emerald).
  const yTicks = [
    { v: 0, cls: "stroke-border/40", dash: false },
    { v: 50, cls: "stroke-amber-500/40", dash: true },
    { v: 80, cls: "stroke-emerald-500/40", dash: true },
    { v: 100, cls: "stroke-border/40", dash: false },
  ];

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ aspectRatio: `${W} / ${H}` }}
        role="img"
        aria-label="Biểu đồ xu hướng điểm qua các bài học"
      >
        {/* Y gridlines + tick labels (give the threshold lines meaning) */}
        {yTicks.map((t) => {
          const y = yOf(t.v / 100);
          return (
            <g key={t.v}>
              <line
                x1={M.l}
                y1={y}
                x2={M.l + pw}
                y2={y}
                className={t.cls}
                strokeWidth={1}
                strokeDasharray={t.dash ? "4 4" : undefined}
              />
              <text
                x={M.l - 7}
                y={y + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {t.v}%
              </text>
            </g>
          );
        })}

        {/* Area + trend line */}
        {n > 1 && <polygon points={areaPts} className="fill-primary/10" />}
        {n > 1 && (
          <polyline
            points={linePts}
            className="fill-none stroke-primary"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Points (+ hit areas, value labels) */}
        {points.map((p, i) => {
          const pct = Math.round(p.frac * 100);
          const active = hover === i;
          const cx = xOf(i);
          const cy = yOf(p.frac);
          const labelAbove = p.frac <= 0.85; // avoid clipping at the very top
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="cursor-pointer"
            >
              {/* Full-height hit strip so hovering is forgiving + click opens the lesson */}
              <rect
                x={cx - pw / (2 * Math.max(1, n - 1 || 1))}
                y={M.t}
                width={pw / Math.max(1, n - 1 || 1)}
                height={ph}
                className="cursor-pointer fill-transparent"
                onClick={() => router.push(lessonHref(p.lessonId))}
              />
              {showValueLabels && (
                <text
                  x={cx}
                  y={labelAbove ? cy - 9 : cy + 16}
                  textAnchor="middle"
                  className="fill-foreground text-[10px] font-semibold tabular-nums"
                >
                  {pct}%
                </text>
              )}
              <circle
                cx={cx}
                cy={cy}
                r={active ? 5.5 : 4}
                className={`${tierFill(pct)} stroke-background`}
                strokeWidth={active ? 2.5 : 1.5}
              />
            </g>
          );
        })}

        {/* X-axis baseline + order labels */}
        <line x1={M.l} y1={M.t + ph} x2={M.l + pw} y2={M.t + ph} className="stroke-border" strokeWidth={1} />
        {points.map((p, i) =>
          i % xLabelEvery === 0 || i === n - 1 ? (
            <text
              key={i}
              x={xOf(i)}
              y={M.t + ph + 15}
              textAnchor="middle"
              className="fill-muted-foreground/80 text-[10px] tabular-nums"
            >
              {i + 1}
            </text>
          ) : null,
        )}
      </svg>

      {/* Hover tooltip — chapter + lesson name + exact score (positioned over the point).
          Anchor by the point's horizontal third so the box never overflows the
          container edge: left-anchored near the left edge, right-anchored near the
          right edge, centered in the middle (CSS-only, no portal). */}
      {hover !== null &&
        points[hover] &&
        (() => {
          const frac = n === 1 ? 0.5 : hover / (n - 1);
          // left third → anchor left edge; right third → anchor right edge; else center.
          const anchor = frac < 1 / 3 ? "left" : frac > 2 / 3 ? "right" : "center";
          const translateX =
            anchor === "left" ? "translate-x-0" : anchor === "right" ? "-translate-x-full" : "-translate-x-1/2";
          // A point in the upper half sits near the top — drop the tooltip BELOW it so
          // it doesn't overlap the chart header (mirrors the labelAbove logic above).
          const below = points[hover].frac > 0.5;
          const translateY = below ? "translate-y-0" : "-translate-y-full";
          const gap = below ? "mt-2" : "mb-2";
          return (
            <div
              className={`pointer-events-none absolute z-10 ${translateY} ${translateX}`}
              style={{ left: `${(xOf(hover) / W) * 100}%`, top: `${(yOf(points[hover].frac) / H) * 100}%` }}
            >
              {/* FIXED width (not max-w): a right-anchored box positioned by `left` +
                  translate-x-full would otherwise shrink-to-fit against the few px of
                  space left of the container edge and collapse into a clipped column.
                  Narrower on small screens so a centre-anchored box doesn't clip the
                  edge on a narrow viewport. */}
              <div className={`${gap} w-52 sm:w-60 whitespace-normal break-words rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md`}>
                {points[hover].moduleTitle && (
                  <div className="text-[10px] font-medium text-muted-foreground">
                    {points[hover].moduleTitle}
                  </div>
                )}
                <div className="font-medium">
                  {points[hover].lessonNumber > 0 && (
                    <span className="text-primary">Bài {points[hover].lessonNumber}: </span>
                  )}
                  {points[hover].lessonTitle}
                </div>
                <div className="tabular-nums text-muted-foreground">
                  Điểm:{" "}
                  <span className={`font-semibold ${tierText(Math.round(points[hover].frac * 100))}`}>
                    {Math.round(points[hover].frac * 100)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
