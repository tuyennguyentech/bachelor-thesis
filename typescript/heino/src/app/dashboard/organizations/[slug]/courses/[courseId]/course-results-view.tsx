"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/pagination";
import { AlertTriangleIcon, BarChart2Icon, ListIcon, ScatterChartIcon, XIcon } from "lucide-react";
import { engagementBadge } from "@/lib/engagement-utils";
import { cn } from "@/lib/utils";
import { scoreBarClass } from "@/components/score-viz";
import { ScoreDistributionChart, EngagementScatterChart } from "./course-results-charts";
import { InfoHint } from "@/components/ui/info-hint";
import { HoverTip } from "@/components/ui/hover-tip";

export interface ResultRow {
  userId: string;
  displayName: string;
  email: string;
  lessonsCompleted: number;
  lessonsTotal: number;
  avgScorePct: number;
  responseRatePct: number;
  watchPct: number;
  engagementScore: number;
  lastActive: string | null;
  hasAttempt: boolean;
  flagged: boolean;
  // raw totals (for the "Tổng" mode)
  totalScore: number;
  totalMaxScore: number;
  totalResponses: number;
  totalInteractions: number;
  totalTimeMs: number;
}

export interface AtRiskRow {
  userId: string;
  label: string;
  lowStreakCount: number;
  /** Ordered low-engagement lessons (title + engagement 0–100) for the diagnosis strip. */
  lowStreak: { label: string; score: number }[];
}

type Mode = "average" | "total";
type SubTab = "list" | "distribution" | "scatter" | "at-risk";

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return "—";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h} giờ ${m} phút`;
  if (m > 0) return `${m} phút`;
  return `${totalSec} giây`;
}

/** A small label + value metric chip used in the summary row. */
function StatChip({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 shadow-sm">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {hint && <InfoHint text={hint} />}
      </span>
      <span className="text-lg font-semibold tabular-nums leading-none">{value}</span>
    </div>
  );
}

/** The drill-down list shown under a chart when a band/bubble is clicked: who
 *  is in that slice + their key metrics, sorted by score. */
function DrillDownPanel({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: ResultRow[];
  onClose: () => void;
}) {
  const sorted = [...rows].sort((a, b) => a.avgScorePct - b.avgScorePct);
  return (
    <div className="mt-3 rounded-md border bg-muted/20" data-testid="chart-drilldown">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">
          {title} · <span className="tabular-nums text-muted-foreground">{rows.length} học viên</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Đóng"
          data-testid="chart-drilldown-close"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="px-3 py-4 text-center text-sm text-muted-foreground">Không có học viên trong nhóm này.</p>
      ) : (
        <div className="divide-y">
          {sorted.map((s) => (
            <div key={s.userId} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{s.displayName || s.userId}</div>
                {s.email && <div className="truncate text-xs text-muted-foreground">{s.email}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-4 text-xs tabular-nums">
                <span className="flex flex-col items-end">
                  <span className="text-[10px] uppercase text-muted-foreground">Điểm</span>
                  <span className="font-semibold">{s.avgScorePct}%</span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="text-[10px] uppercase text-muted-foreground">% xem</span>
                  <span>{s.watchPct}%</span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="text-[10px] uppercase text-muted-foreground">Tiến độ</span>
                  <span>
                    {s.lessonsCompleted}/{s.lessonsTotal > 0 ? s.lessonsTotal : "—"}
                  </span>
                </span>
                {engagementBadge(s.engagementScore)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CourseResultsView({
  rows,
  atRisk,
  page,
  hasNext,
  loadError,
}: {
  rows: ResultRow[];
  atRisk: AtRiskRow[];
  page: number;
  hasNext: boolean;
  loadError: string | null;
}) {
  const [mode, setMode] = useState<Mode>("average");
  const [subTab, setSubTab] = useState<SubTab>("list");
  // Drill-down selections for the two interactive charts.
  const [bandSel, setBandSel] = useState<number | null>(null);
  const [scatterSel, setScatterSel] = useState<{ key: string; userIds: string[] } | null>(null);
  const isTotal = mode === "total";

  // Summary metrics — computed from the current page's rows (responses are paged).
  const activeCount = rows.filter((r) => r.hasAttempt).length;
  const avgProgressPct =
    rows.length > 0
      ? Math.round(
          (rows.reduce(
            (acc, r) => acc + (r.lessonsTotal > 0 ? r.lessonsCompleted / r.lessonsTotal : 0),
            0,
          ) /
            rows.length) *
            100,
        )
      : 0;
  const scored = rows.filter((r) => r.hasAttempt);
  const avgClassScorePct =
    scored.length > 0
      ? Math.round((scored.reduce((acc, r) => acc + r.avgScorePct, 0) / scored.length))
      : null;

  // Class totals
  const sumLessonsDone = rows.reduce((a, r) => a + r.lessonsCompleted, 0);
  const sumScore = rows.reduce((a, r) => a + r.totalScore, 0);
  const sumMaxScore = rows.reduce((a, r) => a + r.totalMaxScore, 0);
  const sumTimeMs = rows.reduce((a, r) => a + r.totalTimeMs, 0);

  // Class score-distribution: bucket students-with-attempts into 5 score bands.
  // The mean hides whether the class is bimodal, left-skewed, or tightly clustered.
  const scoredForHist = rows.filter((r) => r.hasAttempt);
  const histBins = [
    { label: "0–19", lo: 0, hi: 20, frac: 0.1 },
    { label: "20–39", lo: 20, hi: 40, frac: 0.3 },
    { label: "40–59", lo: 40, hi: 60, frac: 0.5 },
    { label: "60–79", lo: 60, hi: 80, frac: 0.7 },
    { label: "80–100", lo: 80, hi: 101, frac: 0.9 },
  ].map((b) => {
    const members = scoredForHist.filter((r) => r.avgScorePct >= b.lo && r.avgScorePct < b.hi);
    return { label: b.label, frac: b.frac, count: members.length, members };
  });

  // Engagement × score points — separates "tried hard but struggling" from
  // "capable but coasting" from "needs attention" (low/low).
  const scatterPoints = scoredForHist.map((r) => ({
    userId: r.userId,
    engagement: r.engagementScore,
    score: r.avgScorePct,
    label: r.displayName || r.userId,
    email: r.email,
    flagged: r.flagged,
  }));

  // Drill-down: which histogram band / scatter group is currently expanded.
  const rowsById = new Map(rows.map((r) => [r.userId, r]));
  const bandRows = bandSel !== null ? histBins[bandSel]?.members ?? [] : [];
  const scatterRows =
    scatterSel !== null
      ? scatterSel.userIds.map((id) => rowsById.get(id)).filter((r): r is ResultRow => !!r)
      : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Mode toggle + summary */}
      {!loadError && rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {isTotal ? (
              <>
                <StatChip
                  label="Bài hoàn thành"
                  value={String(sumLessonsDone)}
                  hint="Tổng số lượt bài học đã hoàn thành của cả lớp (trang hiện tại)."
                />
                <StatChip
                  label="Điểm đạt được"
                  value={`${Math.round(sumScore)}/${Math.round(sumMaxScore)}`}
                  hint="Tổng điểm đạt được trên tổng điểm tối đa của cả lớp."
                />
                <StatChip
                  label="Thời gian làm bài"
                  value={fmtDuration(sumTimeMs)}
                  hint="Tổng thời gian trả lời câu hỏi của cả lớp (không tính thời gian xem video)."
                />
              </>
            ) : (
              <>
                <StatChip
                  label="Học viên hoạt động"
                  value={`${activeCount}/${rows.length}`}
                  hint="Số học viên đã làm ít nhất một bài, trên tổng số học viên (trang hiện tại)."
                />
                <StatChip
                  label="Tiến độ TB"
                  value={`${avgProgressPct}%`}
                  hint="Tiến độ trung bình của lớp: tỉ lệ bài đã hoàn thành trên tổng số bài."
                />
                <StatChip
                  label="Điểm TB lớp"
                  value={avgClassScorePct !== null ? `${avgClassScorePct}%` : "—"}
                  hint="Điểm trung bình của các học viên đã làm bài (không tính người chưa làm)."
                />
              </>
            )}
          </div>

          {/* Average / Total segmented control */}
          <div
            className="inline-flex shrink-0 rounded-lg border bg-muted/40 p-0.5"
            role="tablist"
            aria-label="Chế độ hiển thị"
          >
            {(
              [
                ["average", "Trung bình"],
                ["total", "Tổng"],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                data-testid={`results-mode-${m}`}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                  mode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sub-tab nav: Danh sách kết quả · Phân bố điểm · Tương tác × Điểm · Cần chú ý.
          The "Cần chú ý" tab only appears when there are at-risk students, and is
          tinted red with a count so it still draws the eye now that it is no longer
          an always-on inline box. */}
      {!loadError && rows.length > 0 && (
        <div
          className="inline-flex flex-wrap gap-1 self-start rounded-lg border bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Chế độ xem kết quả"
        >
          {(
            [
              ["list", "Danh sách kết quả", ListIcon],
              ["distribution", "Phân bố điểm", BarChart2Icon],
              ["scatter", "Tương tác × Điểm", ScatterChartIcon],
              ...(atRisk.length > 0
                ? ([["at-risk", "Cần chú ý", AlertTriangleIcon]] as [SubTab, string, typeof ListIcon][])
                : []),
            ] as [SubTab, string, typeof ListIcon][]
          ).map(([t, label, Icon]) => {
            const isAtRisk = t === "at-risk";
            const selected = subTab === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setSubTab(t)}
                data-testid={`results-subtab-${t}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  selected
                    ? isAtRisk
                      ? "bg-background text-red-700 shadow-sm dark:text-red-400"
                      : "bg-background text-foreground shadow-sm"
                    : isAtRisk
                      ? "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
                {isAtRisk && (
                  <span className="ml-0.5 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold tabular-nums text-white">
                    {atRisk.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Tab: Cần chú ý — students needing attention, as a responsive card grid */}
      {!loadError && atRisk.length > 0 && subTab === "at-risk" && (
        <div className="flex flex-col gap-3" data-testid="at-risk-section">
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 dark:border-red-900/50 dark:bg-red-950/20">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
            <p className="text-xs text-red-700/90 dark:text-red-400/90">
              <span className="font-medium">{atRisk.length} học viên cần chú ý.</span>{" "}
              Tiêu chí: điểm tương tác dưới 40 hoặc điểm dưới 50%, hoặc có từ 2 bài
              liên tiếp tương tác thấp. Mỗi ô là một bài học tương tác thấp (đỏ = rất
              thấp, vàng = thấp) — di chuột để xem chi tiết.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {atRisk.map((s) => (
              <div
                key={s.userId}
                data-testid="at-risk-card"
                className="flex flex-col gap-2.5 rounded-lg border bg-card p-3 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold" title={s.label}>
                    {s.label}
                  </span>
                  {s.lowStreak.length > 0 ? (
                    <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
                      {s.lowStreak.length} bài liên tiếp
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      điểm dưới ngưỡng
                    </span>
                  )}
                </div>
                {s.lowStreak.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {s.lowStreak.map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <HoverTip
                          label={
                            <span>
                              <span className="font-medium">{p.label || "Bài học"}</span>
                              {" · tương tác "}
                              <span className="tabular-nums">{Math.round(p.score)}/100</span>
                            </span>
                          }
                        >
                          <div
                            data-testid="at-risk-square"
                            className={cn("size-3 shrink-0 cursor-help rounded-sm", scoreBarClass(p.score / 100))}
                          />
                        </HoverTip>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={p.label}>
                          {p.label || "Bài học"}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {Math.round(p.score)}/100
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Điểm trung bình dưới ngưỡng đạt.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Phân bố điểm */}
      {!loadError && rows.length > 0 && subTab === "distribution" && (
        <div className="rounded-md border bg-card p-4" data-testid="score-distribution">
          <div className="mb-3 flex items-center gap-2">
            <BarChart2Icon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Phân bố điểm</h3>
            <span className="text-xs text-muted-foreground">({scoredForHist.length} học viên)</span>
            <InfoHint text="Số học viên trong từng khoảng điểm. Giúp thấy lớp có bị phân hóa hay tập trung mà điểm trung bình không thể hiện. Di chuột để xem số liệu, BẤM vào cột để xem danh sách học viên trong khoảng đó." />
          </div>
          <ScoreDistributionChart
            bins={histBins}
            total={scoredForHist.length}
            avgPct={avgClassScorePct}
            selected={bandSel}
            onSelectBand={setBandSel}
          />
          <p className="mt-1 text-xs text-muted-foreground">Bấm vào một cột để xem ai thuộc khoảng điểm đó.</p>
          {bandSel !== null && histBins[bandSel] && (
            <DrillDownPanel
              title={`Khoảng điểm ${histBins[bandSel].label}%`}
              rows={bandRows}
              onClose={() => setBandSel(null)}
            />
          )}
        </div>
      )}

      {/* Tab: Tương tác × Điểm */}
      {!loadError && rows.length > 0 && subTab === "scatter" && (
        <div className="rounded-md border bg-card p-4" data-testid="engagement-scatter">
          <div className="mb-3 flex items-center gap-2">
            <ScatterChartIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Tương tác × Điểm</h3>
            <InfoHint text="Mỗi chấm là một học viên: trục ngang = Tương tác, trục dọc = Điểm. Di chuột vào chấm để xem tên, điểm và tương tác; BẤM vào chấm để xem chi tiết học viên ở vị trí đó. Đường nét đứt là các mốc (tương tác 40/70, điểm 50/80); vùng đỏ góc dưới-trái là nhóm cần chú ý." />
          </div>
          {scatterPoints.length > 0 ? (
            <>
              {scatterPoints.length < 6 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  Lớp còn ít học viên — biểu đồ chỉ mang tính tham khảo.
                </p>
              )}
              <EngagementScatterChart
                points={scatterPoints}
                selectedKey={scatterSel?.key ?? null}
                onSelectGroup={setScatterSel}
              />
              <p className="mt-1 text-xs text-muted-foreground">Bấm vào một chấm để xem chi tiết học viên ở vị trí đó.</p>
              {scatterSel !== null && (
                <DrillDownPanel
                  title="Học viên tại vị trí đã chọn"
                  rows={scatterRows}
                  onClose={() => setScatterSel(null)}
                />
              )}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Chưa có học viên nào làm bài.
            </p>
          )}
        </div>
      )}

      {/* Tab: Danh sách kết quả (also the fallback for empty / error states) */}
      {(loadError || rows.length === 0 || subTab === "list") && (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Học viên</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  Tiến độ
                  <InfoHint text="Số bài đã hoàn thành trên tổng số bài học của khóa." />
                </span>
              </TableHead>
              {isTotal ? (
                <>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Điểm
                      <InfoHint text="Tổng điểm đạt được trên tổng điểm tối đa của các bài đã làm." />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Thời gian
                      <InfoHint text="Tổng thời gian trả lời câu hỏi (không tính thời gian xem video)." />
                    </span>
                  </TableHead>
                </>
              ) : (
                <>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Điểm TB
                      <InfoHint text="Điểm trung bình của các bài đã làm, theo phần trăm." />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      % xem
                      <InfoHint text="Tỉ lệ thời lượng video đã xem, trung bình trên các bài." />
                    </span>
                  </TableHead>
                </>
              )}
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  Tương tác
                  <InfoHint text="Điểm tương tác tổng hợp 0–100: 50% mức xem video + 50% điểm bài làm. Xanh ≥ 70, vàng 40–69, đỏ < 40." />
                </span>
              </TableHead>
              <TableHead>Hoạt động gần nhất</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadError ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={<AlertTriangleIcon className="size-5" />}
                    title="Không thể tải dữ liệu"
                    description={loadError}
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={<BarChart2Icon className="size-5" />}
                    title="Chưa có dữ liệu"
                    description="Chưa có học viên nào nộp bài trong khóa học này."
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => {
                const progress =
                  s.lessonsTotal > 0
                    ? `${s.lessonsCompleted}/${s.lessonsTotal}`
                    : `${s.lessonsCompleted}/—`;
                const progressPct =
                  s.lessonsTotal > 0
                    ? Math.round((s.lessonsCompleted / s.lessonsTotal) * 100)
                    : null;
                return (
                  <TableRow key={s.userId}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {s.displayName || s.userId}
                          {s.flagged && (
                            <Badge
                              variant="outline"
                              className="border-red-300 bg-red-100 px-1.5 py-0 text-[10px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400"
                            >
                              Cần chú ý
                            </Badge>
                          )}
                        </span>
                        {s.email && (
                          <span className="text-xs text-muted-foreground">{s.email}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-sm tabular-nums">{progress}</span>
                        {progressPct !== null && (
                          <>
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {progressPct}%
                            </span>
                          </>
                        )}
                      </div>
                    </TableCell>
                    {isTotal ? (
                      <>
                        <TableCell className="tabular-nums text-sm">
                          {s.hasAttempt
                            ? `${Math.round(s.totalScore)}/${Math.round(s.totalMaxScore)}`
                            : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">
                          {s.hasAttempt ? fmtDuration(s.totalTimeMs) : "—"}
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="tabular-nums text-sm">
                          {s.hasAttempt ? `${s.avgScorePct}%` : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">
                          {s.hasAttempt ? `${s.watchPct}%` : "—"}
                        </TableCell>
                      </>
                    )}
                    <TableCell>
                      {s.hasAttempt ? (
                        engagementBadge(s.engagementScore)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.lastActive ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {/* Show on the list tab even when the page is empty, so a user who paged
          past shrunken data can still page back (rows.length>0 would trap them). */}
      {!loadError && subTab === "list" && (
        <Pagination page={page} hasNext={hasNext} buildHref={(p) => `?tab=results&page=${p}`} />
      )}
    </div>
  );
}
