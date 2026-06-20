"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUpIcon,
  PlayIcon,
  CheckCircle2,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";
import { ScoreTrendChart } from "./score-trend-chart";

export interface ModuleProgress {
  id: string;
  title: string;
  lessonCount: number;
  completed: number;
  scoreFrac: number | null;
  lessons: {
    id: string;
    title: string;
    completed: boolean;
    scoreFrac: number | null;
  }[];
}

export interface StudentProgressCardProps {
  totalLessons: number;
  lessonsDone: number;
  progressPct: number;
  avgScorePct: number | null;
  scoreTrend: { frac: number; label: string }[];
  nextLesson: { id: string; title: string } | null;
  moduleProgress: ModuleProgress[];
  // Pieces to build lesson links client-side. A server component CANNOT pass a
  // function prop to a client component (RSC serialization throws), so we pass the
  // route params + learn-mode flag and construct the href here instead.
  slug: string;
  courseId: string;
  learnMode: boolean;
}

function scoreColor(frac: number | null): string {
  if (frac === null) return "text-muted-foreground";
  if (frac >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (frac >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function scoreBar(frac: number | null): string {
  if (frac === null) return "bg-muted-foreground/30";
  if (frac >= 0.8) return "bg-emerald-500";
  if (frac >= 0.5) return "bg-amber-500";
  return "bg-red-500";
}

function stripPrefix(title: string): string {
  const m = title.match(/^(Bài\s+\d+):\s*(.+)$/);
  return m ? m[2] : title;
}

export function StudentProgressCard({
  totalLessons,
  lessonsDone,
  progressPct,
  avgScorePct,
  scoreTrend,
  nextLesson,
  moduleProgress,
  slug,
  courseId,
  learnMode,
}: StudentProgressCardProps) {
  const [expandedModule, setExpandedModule] = useState<string | null>(null);

  // Mirrors the server lessonHref (carry mode=learn so a manager previewing as a
  // student keeps the learner view on the lesson page).
  const lessonHref = (lessonId: string) =>
    `/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}${learnMode ? "?mode=learn" : ""}`;

  const remaining = totalLessons - lessonsDone;

  return (
    <div
      className="rounded-xl border bg-card p-5 shadow-sm flex flex-col gap-4"
      data-testid="my-course-progress"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <TrendingUpIcon className="size-4 text-emerald-500" />
          <h2 className="font-semibold">Tiến độ của bạn</h2>
        </div>
        {avgScorePct !== null && (
          <Badge variant="secondary" className="gap-1 font-normal">
            Điểm trung bình:{" "}
            <span className={`font-semibold tabular-nums ${scoreColor(avgScorePct / 100)}`}>
              {avgScorePct}%
            </span>
          </Badge>
        )}
      </div>

      {/* Overall progress — segmented bar */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">{lessonsDone}</span>
            /{totalLessons} bài học đã làm
            {remaining > 0 && (
              <span className="ml-1 text-muted-foreground/70">· còn {remaining} bài</span>
            )}
          </span>
          <span className="text-sm font-semibold tabular-nums">{progressPct}%</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted flex">
          <div
            className="h-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Score trend sparkline */}
      {scoreTrend.length >= 2 && (
        <div className="flex flex-col gap-1" data-testid="score-trend">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              Xu hướng điểm qua các bài
              <InfoHint text="Điểm của bạn qua từng bài, theo thứ tự làm. Trục dọc là thang điểm %; đường nét đứt vàng (50%) và xanh (80%) là mốc tham chiếu. Đưa chuột vào từng điểm để xem tên bài và điểm chi tiết." />
            </span>
            <span
              className={`text-xs font-medium tabular-nums ${scoreColor(scoreTrend[scoreTrend.length - 1].frac)}`}
            >
              Gần nhất: {Math.round(scoreTrend[scoreTrend.length - 1].frac * 100)}%
            </span>
          </div>
          <ScoreTrendChart points={scoreTrend} />
        </div>
      )}

      {/* Next lesson CTA */}
      {nextLesson ? (
        <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <p className="text-sm text-muted-foreground min-w-0">
            {lessonsDone === 0 ? "Bắt đầu với" : "Tiếp theo"}:{" "}
            <span className="font-medium text-foreground">
              {stripPrefix(nextLesson.title)}
            </span>
          </p>
          <Button asChild className="gap-2 shrink-0" size="sm">
            <Link href={lessonHref(nextLesson.id)}>
              <PlayIcon className="size-4" />
              {lessonsDone === 0 ? "Bắt đầu học" : "Tiếp tục học"}
            </Link>
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>Bạn đã làm hết tất cả bài học trong khóa học này. 🎉</span>
        </div>
      )}

      {/* Per-chapter breakdown — interactive, expandable */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Tiến độ theo chương
          </span>
          <span className="text-xs text-muted-foreground/60">
            (nhấn để xem chi tiết)
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          {moduleProgress.map((m, mi) => {
            const isExpanded = expandedModule === m.id;
            const chapterDone = m.lessonCount > 0 && m.completed === m.lessonCount;
            return (
              <div key={m.id} className="rounded-lg border bg-background overflow-hidden">
                {/* Chapter row — clickable */}
                <button
                  onClick={() => setExpandedModule(isExpanded ? null : m.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="text-xs text-muted-foreground w-5 shrink-0 text-right tabular-nums">
                    {mi + 1}
                  </span>
                  {isExpanded ? (
                    <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-xs truncate flex-1 min-w-0 font-medium" title={m.title}>
                    {m.title}
                  </span>
                  {/* Segmented progress bar */}
                  <div className="h-2 w-24 sm:w-32 shrink-0 rounded-full bg-muted overflow-hidden flex">
                    {m.lessons.map((l) => (
                      <div
                        key={l.id}
                        className={`h-full flex-1 ${l.completed ? scoreBar(l.scoreFrac) : "bg-transparent"}`}
                        title={l.title}
                      />
                    ))}
                  </div>
                  <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground tabular-nums w-28 shrink-0">
                    {chapterDone && <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />}
                    <span>
                      {m.completed}/{m.lessonCount} bài
                      {m.scoreFrac !== null && (
                        <span className={`ml-1 font-medium ${scoreColor(m.scoreFrac)}`}>
                          · {Math.round(m.scoreFrac * 100)}%
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                {/* Expanded lesson list */}
                {isExpanded && (
                  <div className="border-t bg-muted/20 flex flex-col">
                    {m.lessons.map((l) => (
                      <Link
                        key={l.id}
                        href={lessonHref(l.id)}
                        className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-muted/60 transition-colors group"
                      >
                        <span className="w-5 shrink-0" />
                        <span className="w-4 shrink-0">
                          {l.completed ? (
                            <CheckCircle2 className="size-3 text-emerald-500" />
                          ) : (
                            <div className="size-3 rounded-full border border-muted-foreground/30" />
                          )}
                        </span>
                        <span className="text-xs truncate flex-1 min-w-0 group-hover:text-foreground" title={l.title}>
                          {stripPrefix(l.title)}
                        </span>
                        {l.completed && l.scoreFrac !== null && (
                          <span className={`text-xs tabular-nums font-medium ${scoreColor(l.scoreFrac)}`}>
                            {Math.round(l.scoreFrac * 100)}%
                          </span>
                        )}
                        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50 group-hover:text-foreground" />
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
