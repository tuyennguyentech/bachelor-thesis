/**
 * Shared score-visualization primitives — hand-rolled SVG/CSS, no chart library.
 * Reused by the lesson result, course results, and analytics surfaces so the
 * red/amber/green thresholds and bar markup never drift apart.
 */

/** Map a 0..1 score fraction to a qualitative tier. */
export function scoreTier(frac: number): "high" | "mid" | "low" {
  if (frac >= 0.8) return "high";
  if (frac >= 0.5) return "mid";
  return "low";
}

const TIER_BAR = {
  high: "bg-emerald-500",
  mid: "bg-amber-500",
  low: "bg-red-500",
} as const;

const TIER_TEXT = {
  high: "text-emerald-600 dark:text-emerald-400",
  mid: "text-amber-600 dark:text-amber-400",
  low: "text-red-600 dark:text-red-400",
} as const;

export function scoreBarClass(frac: number): string {
  return TIER_BAR[scoreTier(frac)];
}

export function scoreTextClass(frac: number): string {
  return TIER_TEXT[scoreTier(frac)];
}

/**
 * A labeled horizontal bar: left label, colored fill proportional to `frac`
 * (0..1), and a right-hand value (defaults to the percentage).
 */
export function ScoreBar({
  label,
  frac,
  right,
  colorByScore = true,
  labelClass = "w-24",
}: {
  label: string;
  frac: number;
  right?: string;
  colorByScore?: boolean;
  /** Width utility for the label column. Widen (e.g. "w-32") for long labels
   *  like "MCQ nhiều đáp án" that would otherwise truncate. */
  labelClass?: string;
}) {
  const clamped = Math.max(0, Math.min(1, frac));
  const pct = Math.round(clamped * 100);
  return (
    <div className="flex items-center gap-2">
      <span className={`${labelClass} shrink-0 truncate text-xs text-muted-foreground`} title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${colorByScore ? scoreBarClass(clamped) : "bg-primary/70"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {right ?? `${pct}%`}
      </span>
    </div>
  );
}

/**
 * A small score-over-sequence trend line (e.g. score per lesson in order). Each
 * point is colored by its score tier; reference lines at 50% and 80%.
 */
export function ScoreTrend({
  points,
  className,
}: {
  points: { frac: number; label: string }[];
  className?: string;
}) {
  if (points.length === 0) return null;
  const W = 300;
  const H = 80;
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (frac: number) => (1 - Math.max(0, Math.min(1, frac))) * H;
  const line = points.map((p, i) => `${x(i)},${y(p.frac)}`).join(" ");
  return (
    <div className={className}>
      <svg viewBox={`-4 -4 ${W + 8} ${H + 8}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Xu hướng điểm">
        {/* reference lines at 80% (green) and 50% (amber) */}
        <line x1={0} y1={y(0.8)} x2={W} y2={y(0.8)} className="stroke-emerald-500/30" strokeWidth={1} strokeDasharray="4 4" />
        <line x1={0} y1={y(0.5)} x2={W} y2={y(0.5)} className="stroke-amber-500/30" strokeWidth={1} strokeDasharray="4 4" />
        {n > 1 && <polyline points={line} className="fill-none stroke-primary/60" strokeWidth={2} />}
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.frac)} r={i === n - 1 ? 4 : 3} className={scoreBarClass(p.frac).replace("bg-", "fill-")}>
            <title>{`${p.label}: ${Math.round(p.frac * 100)}%`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
