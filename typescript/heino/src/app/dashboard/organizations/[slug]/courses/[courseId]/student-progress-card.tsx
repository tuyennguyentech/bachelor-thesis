"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUpIcon,
  PlayIcon,
  CheckCircle2,
  CheckIcon,
  ChevronDownIcon,
  ArrowRightIcon,
} from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";
import { cn } from "@/lib/utils";
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
  scoreTrend: { frac: number; lessonId: string; lessonTitle: string; lessonNumber: number; moduleTitle: string }[];
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

/** Pill (bg + text + border) for the per-chapter mastery score, by tier. */
function scoreBadge(frac: number | null): string {
  if (frac === null) return "border-border text-muted-foreground";
  if (frac >= 0.8)
    return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400";
  if (frac >= 0.5)
    return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400";
  return "border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400";
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
  const chaptersDone = moduleProgress.filter(
    (m) => m.lessonCount > 0 && m.completed === m.lessonCount,
  ).length;

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
          <ScoreTrendChart points={scoreTrend} slug={slug} courseId={courseId} learnMode={learnMode} />
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

      {/* Per-chapter breakdown — completion + mastery, expandable to a lesson list.
          Completion (the bar) and mastery (the score pill) are kept as two distinct
          reads; a clean per-chapter bar stays legible no matter how many lessons a
          chapter has (the old per-lesson segments turned to slivers). */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Tiến độ theo chương</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {chaptersDone}/{moduleProgress.length} chương hoàn thành
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {moduleProgress.map((m, mi) => {
            const isExpanded = expandedModule === m.id;
            const chapterDone = m.lessonCount > 0 && m.completed === m.lessonCount;
            const pct = m.lessonCount > 0 ? Math.round((m.completed / m.lessonCount) * 100) : 0;
            const scorePct = m.scoreFrac !== null ? Math.round(m.scoreFrac * 100) : null;
            return (
              <li
                key={m.id}
                className="overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/30"
              >
                <button
                  type="button"
                  onClick={() => setExpandedModule(isExpanded ? null : m.id)}
                  aria-expanded={isExpanded}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* The chapter marker carries real state: its number until done,
                      then a check (the order is meaningful — chapters are a sequence). */}
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                      chapterDone
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {chapterDone ? <CheckIcon className="size-4" /> : mi + 1}
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium" title={m.title}>
                        {m.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {m.completed}/{m.lessonCount} bài
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-500",
                          chapterDone ? "bg-emerald-500" : "bg-primary",
                        )}
                        style={{ width: `${m.completed > 0 ? Math.max(pct, 4) : 0}%` }}
                      />
                    </div>
                  </div>

                  {scorePct !== null ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                        scoreBadge(m.scoreFrac),
                      )}
                      title="Điểm trung bình của chương"
                    >
                      {scorePct}%
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground/50">—</span>
                  )}

                  <ChevronDownIcon
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                      isExpanded && "rotate-180",
                    )}
                  />
                </button>

                {isExpanded && (
                  <ul className="border-t bg-muted/20">
                    {m.lessons.map((l) => (
                      <li key={l.id}>
                        <Link
                          href={lessonHref(l.id)}
                          className="group flex items-center gap-2.5 py-2 pl-[3.25rem] pr-3 transition-colors hover:bg-muted/50"
                        >
                          {l.completed ? (
                            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                          ) : (
                            <span className="size-3.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/30" />
                          )}
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground"
                            title={l.title}
                          >
                            {stripPrefix(l.title)}
                          </span>
                          {l.completed && l.scoreFrac !== null && (
                            <span className={cn("shrink-0 text-xs font-medium tabular-nums", scoreColor(l.scoreFrac))}>
                              {Math.round(l.scoreFrac * 100)}%
                            </span>
                          )}
                          <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
