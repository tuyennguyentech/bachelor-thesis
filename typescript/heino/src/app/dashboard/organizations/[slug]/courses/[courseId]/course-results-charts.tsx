"use client";

import { useState } from "react";

/* Interactive, full-width SVG charts for the course results page. Hand-rolled
 * (no chart lib) but with real React hover state — a positioned tooltip, axis
 * ticks, gridlines and threshold guides — so the distribution and the
 * engagement×score quadrant are actually readable. */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function tierFill(scorePct: number): string {
  if (scorePct >= 80) return "fill-emerald-500";
  if (scorePct >= 50) return "fill-amber-500";
  return "fill-red-500";
}

// ── Score distribution ────────────────────────────────────────────────────────

export interface DistBin {
  label: string;
  count: number;
  frac: number; // representative 0..1 score for the band's colour
}

export function ScoreDistributionChart({
  bins,
  total,
  avgPct,
  selected = null,
  onSelectBand,
}: {
  bins: DistBin[];
  total: number;
  avgPct: number | null;
  /** Index of the band currently drilled into (highlighted). */
  selected?: number | null;
  /** Click a band to drill into it; called with the band index (or null to clear). */
  onSelectBand?: (i: number | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bins.map((b) => b.count));
  // Integer y-axis ticks from 0..max (at most ~5 ticks).
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);

  const W = 640;
  const H = 300;
  const M = { l: 36, r: 16, t: 16, b: 40 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const bandW = pw / bins.length;
  const barW = bandW * 0.6;
  const yOf = (count: number) => M.t + (1 - count / max) * ph;

  if (total === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">Chưa có dữ liệu điểm.</p>
    );
  }

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Biểu đồ phân bố điểm">
        {/* y gridlines + tick labels */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} y1={yOf(t)} x2={M.l + pw} y2={yOf(t)} className="stroke-border/50" strokeWidth={1} />
            <text x={M.l - 8} y={yOf(t) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{t}</text>
          </g>
        ))}
        {/* bars */}
        {bins.map((b, i) => {
          const x = M.l + i * bandW + (bandW - barW) / 2;
          const y = yOf(b.count);
          const h = M.t + ph - y;
          const isSel = selected === i;
          const active = hover === i || isSel;
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => b.count > 0 && onSelectBand?.(selected === i ? null : i)}
              className={onSelectBand && b.count > 0 ? "cursor-pointer" : "cursor-default"}
            >
              {/* full-band hit area so hover/click is easy */}
              <rect data-band={i} x={M.l + i * bandW} y={M.t} width={bandW} height={ph} className="fill-transparent" />
              <rect
                x={x}
                y={b.count > 0 ? y : M.t + ph - 2}
                width={barW}
                height={b.count > 0 ? Math.max(2, h) : 2}
                rx={3}
                className={`${b.count > 0 ? tierFill(b.frac * 100) : "fill-muted"} ${active ? "opacity-100" : "opacity-85"} transition-opacity`}
                stroke={isSel ? "currentColor" : "none"}
                strokeWidth={isSel ? 2.5 : 0}
              />
              {b.count > 0 && (
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" className="fill-foreground text-xs font-semibold tabular-nums">{b.count}</text>
              )}
              <text x={M.l + i * bandW + bandW / 2} y={M.t + ph + 16} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">{b.label}</text>
              <text x={M.l + i * bandW + bandW / 2} y={M.t + ph + 30} textAnchor="middle" className="fill-muted-foreground/70 text-[10px]">điểm (%)</text>
            </g>
          );
        })}
        {/* axes */}
        <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + ph} className="stroke-border" strokeWidth={1.2} />
        <line x1={M.l} y1={M.t + ph} x2={M.l + pw} y2={M.t + ph} className="stroke-border" strokeWidth={1.2} />
      </svg>
      {hover !== null && bins[hover] && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
          style={{ left: `${(M.l + hover * bandW + bandW / 2) / W * 100}%`, top: `${yOf(bins[hover].count) / H * 100}%` }}
        >
          <div className="mb-1 whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
            <div className="font-medium">Khoảng {bins[hover].label}%</div>
            <div className="text-muted-foreground tabular-nums">
              {bins[hover].count} học viên · {Math.round((bins[hover].count / total) * 100)}% lớp
            </div>
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">{total} học viên có bài làm</span>
        {avgPct !== null && (
          <span className="tabular-nums">
            Điểm TB lớp: <span className="font-semibold text-foreground">{avgPct}%</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Engagement × Score scatter ────────────────────────────────────────────────

export interface ScatterPoint {
  userId: string;
  engagement: number;
  score: number;
  label: string;
  email?: string;
  flagged: boolean;
}

export function EngagementScatterChart({
  points,
  selectedKey = null,
  onSelectGroup,
}: {
  points: ScatterPoint[];
  /** Key of the bubble currently drilled into (controlled highlight). */
  selectedKey?: string | null;
  /** Click a bubble to drill into the learners sitting there, or null to clear. */
  onSelectGroup?: (sel: { key: string; userIds: string[] } | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 640;
  const H = 420;
  const M = { l: 48, r: 18, t: 18, b: 44 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const px = (e: number) => M.l + (clamp(e, 0, 100) / 100) * pw;
  const py = (s: number) => M.t + (1 - clamp(s, 0, 100) / 100) * ph;

  // Learners who share the same (engagement, score) collapse into ONE bubble
  // sized by how many sit there — rather than jittering them apart, which would
  // misrepresent their true position. The tooltip then lists everyone at that
  // spot. Coordinates are integers, so exact ties group cleanly.
  const groups = new Map<string, { e: number; s: number; members: ScatterPoint[]; flagged: boolean }>();
  for (const p of points) {
    const e = Math.round(clamp(p.engagement, 0, 100));
    const s = Math.round(clamp(p.score, 0, 100));
    const key = `${e}:${s}`;
    const g = groups.get(key) ?? { e, s, members: [], flagged: false };
    g.members.push(p);
    g.flagged = g.flagged || p.flagged;
    groups.set(key, g);
  }
  const bubbles = [...groups.values()].map((g) => ({
    ...g,
    key: `${g.e}:${g.s}`,
    count: g.members.length,
    x: px(g.e),
    y: py(g.s),
    // Area ∝ count so a big tie reads bigger without dwarfing the plot.
    r: Math.min(16, 5 * Math.sqrt(g.members.length)),
  }));

  const xticks = [0, 20, 40, 60, 80, 100];
  const yticks = [0, 20, 40, 60, 80, 100];

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Biểu đồ tương tác và điểm">
        {/* quadrant tints: danger (low/low) red, excellent (high/high) green */}
        <rect x={px(0)} y={py(50)} width={px(40) - px(0)} height={py(0) - py(50)} className="fill-red-500/8" />
        <rect x={px(70)} y={py(100)} width={px(100) - px(70)} height={py(80) - py(100)} className="fill-emerald-500/8" />
        {/* gridlines */}
        {xticks.map((t) => (
          <line key={`gx${t}`} x1={px(t)} y1={M.t} x2={px(t)} y2={M.t + ph} className="stroke-border/40" strokeWidth={1} />
        ))}
        {yticks.map((t) => (
          <line key={`gy${t}`} x1={M.l} y1={py(t)} x2={M.l + pw} y2={py(t)} className="stroke-border/40" strokeWidth={1} />
        ))}
        {/* threshold guides: engagement 40/70, score 50/80 */}
        <line x1={px(40)} y1={M.t} x2={px(40)} y2={M.t + ph} className="stroke-red-400/60" strokeWidth={1} strokeDasharray="4 3" />
        <line x1={px(70)} y1={M.t} x2={px(70)} y2={M.t + ph} className="stroke-emerald-400/50" strokeWidth={1} strokeDasharray="4 3" />
        <line x1={M.l} y1={py(50)} x2={M.l + pw} y2={py(50)} className="stroke-red-400/60" strokeWidth={1} strokeDasharray="4 3" />
        <line x1={M.l} y1={py(80)} x2={M.l + pw} y2={py(80)} className="stroke-emerald-400/50" strokeWidth={1} strokeDasharray="4 3" />
        {/* axis lines */}
        <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + ph} className="stroke-border" strokeWidth={1.2} />
        <line x1={M.l} y1={M.t + ph} x2={M.l + pw} y2={M.t + ph} className="stroke-border" strokeWidth={1.2} />
        {/* tick labels */}
        {xticks.map((t) => (
          <text key={`tx${t}`} x={px(t)} y={M.t + ph + 16} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">{t}</text>
        ))}
        {yticks.map((t) => (
          <text key={`ty${t}`} x={M.l - 8} y={py(t) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{t}</text>
        ))}
        {/* axis titles */}
        <text x={M.l + pw / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[12px]">Tương tác →</text>
        <text x={-(M.t + ph / 2)} y={14} transform="rotate(-90)" textAnchor="middle" className="fill-muted-foreground text-[12px]">Điểm →</text>
        {/* bubbles — one per (engagement, score); size = how many learners sit
            there, with the count drawn inside. A larger transparent hit circle
            (pointer-events) makes hovering easy and reliable. */}
        {bubbles.map((b, i) => {
          const isSel = selectedKey === b.key;
          const active = hover === i || isSel;
          const r = active ? b.r + 3 : b.r;
          return (
            <g key={i}>
              <circle
                cx={b.x}
                cy={b.y}
                r={r}
                className={`${tierFill(b.s)} ${active ? "stroke-foreground" : b.flagged ? "stroke-red-600" : "stroke-background"} pointer-events-none transition-[r]`}
                strokeWidth={active ? 2.5 : b.flagged ? 2 : 1}
                opacity={active ? 1 : 0.85}
              />
              {b.count > 1 && (
                <text
                  x={b.x}
                  y={b.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="pointer-events-none fill-white font-semibold"
                  style={{ fontSize: Math.max(9, Math.min(13, r)) }}
                >
                  {b.count}
                </text>
              )}
              <circle
                cx={b.x}
                cy={b.y}
                r={Math.max(12, r + 4)}
                fill="transparent"
                data-dot={i}
                data-count={b.count}
                className="cursor-pointer"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() =>
                  onSelectGroup?.(
                    selectedKey === b.key
                      ? null
                      : { key: b.key, userIds: b.members.map((m) => m.userId) },
                  )
                }
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && bubbles[hover] && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
          style={{ left: `${bubbles[hover].x / W * 100}%`, top: `${bubbles[hover].y / H * 100}%` }}
        >
          <div className="mb-2 max-w-[16rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
            {bubbles[hover].count === 1 ? (
              <>
                <div className="font-medium">{bubbles[hover].members[0].label}</div>
                {bubbles[hover].members[0].email && (
                  <div className="text-muted-foreground">{bubbles[hover].members[0].email}</div>
                )}
              </>
            ) : (
              <div className="font-medium">{bubbles[hover].count} học viên cùng vị trí</div>
            )}
            <div className="tabular-nums">
              Điểm: <span className="font-semibold text-foreground">{bubbles[hover].s}%</span>
              {" · "}
              Tương tác: <span className="font-semibold text-foreground">{bubbles[hover].e}</span>
            </div>
            {bubbles[hover].count > 1 && (
              <div className="mt-1 leading-snug text-muted-foreground">
                {bubbles[hover].members.slice(0, 6).map((m) => m.label).join(", ")}
                {bubbles[hover].count > 6 ? ` +${bubbles[hover].count - 6} nữa` : ""}
              </div>
            )}
          </div>
        </div>
      )}
      {/* legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-emerald-500" /> Điểm ≥ 80%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-amber-500" /> 50–79%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-red-500" /> &lt; 50%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-red-600" /> cần chú ý</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 bg-red-500/15" /> vùng rủi ro (góc dưới-trái)</span>
        <span className="inline-flex items-center gap-1.5"><span className="flex size-3.5 items-center justify-center rounded-full bg-muted-foreground/60 text-[8px] font-semibold text-white">2</span> nhiều HV trùng vị trí</span>
      </div>
    </div>
  );
}
