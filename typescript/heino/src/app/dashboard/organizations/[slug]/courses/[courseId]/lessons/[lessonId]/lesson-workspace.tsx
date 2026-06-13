"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import type { CourseModule, Lesson } from "buf/gen/richter/v1/courses_pb";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListTreeIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlayCircleIcon,
  ClockIcon,
  FileVideoIcon,
  CircleDotIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LessonWorkspaceShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  storageKey: string;
}

export function LessonWorkspaceShell({ sidebar, children, storageKey }: LessonWorkspaceShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) {
        setSidebarOpen(saved === "true");
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [storageKey]);

  const handleToggle = (open: boolean) => {
    setSidebarOpen(open);
    localStorage.setItem(storageKey, String(open));
  };

  return (
    <div
      className={cn(
        "grid gap-4 lg:min-h-[calc(100svh-7rem)]",
        sidebarOpen
          ? "lg:grid-cols-[320px_minmax(0,1fr)]"
          : "lg:grid-cols-[56px_minmax(0,1fr)]",
      )}
    >
      <aside
        className={cn(
          "relative hidden lg:block lg:order-none overflow-hidden rounded-xl border border-border/80 bg-card/70 backdrop-blur-md shadow-sm transition-all duration-300 outline-none",
          sidebarOpen ? "" : "hover:bg-muted/40 hover:border-primary/30 select-none"
        )}
      >
        <div
          className={cn(
            "h-full min-h-0 flex-col animate-in fade-in duration-200",
            sidebarOpen ? "flex" : "hidden",
          )}
          aria-hidden={!sidebarOpen}
        >
          <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <ListTreeIcon className="size-4 shrink-0 text-primary" />
              <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">Lộ trình bài giảng</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 hover:bg-muted/65"
              aria-label="Ẩn danh sách bài học"
              onClick={() => handleToggle(false)}
            >
              <PanelLeftCloseIcon className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sidebar}
          </div>
        </div>
        <button
          type="button"
          aria-label="Hiện danh sách bài học"
          aria-hidden={sidebarOpen}
          tabIndex={sidebarOpen ? -1 : 0}
          className={cn(
            "h-full min-h-[320px] w-full flex-col items-center justify-between px-2 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
            sidebarOpen ? "hidden" : "flex",
          )}
          onClick={() => handleToggle(true)}
        >
          <span className="flex size-8 items-center justify-center shrink-0">
            <PanelLeftOpenIcon className="size-4 text-primary" />
          </span>
          <span className="flex flex-1 items-center justify-center text-[10px] uppercase font-bold tracking-wider text-muted-foreground [writing-mode:vertical-rl]">
            Mở rộng lộ trình
          </span>
          <span className="size-8" aria-hidden />
        </button>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}

interface LessonCourseSidebarProps {
  slug: string;
  courseId: string;
  courseTitle: string;
  currentLessonId: string;
  modules: CourseModule[];
  lessons: Lesson[];
  /** When "learn", keep links in learn mode (manager learning as a student). */
  mode?: "learn" | "manage";
}

export function LessonCourseSidebar({
  slug,
  courseId,
  courseTitle,
  currentLessonId,
  modules,
  lessons,
  mode,
}: LessonCourseSidebarProps) {
  const learnSuffix = mode === "learn" ? "?mode=learn" : "";
  const courseHref = `/dashboard/organizations/${slug}/courses/${courseId}${mode === "learn" ? "?mode=learn" : ""}`;
  const lessonsByModule = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    const moduleLessons = lessonsByModule.get(lesson.moduleId) ?? [];
    moduleLessons.push(lesson);
    lessonsByModule.set(lesson.moduleId, moduleLessons);
  }

  function formatDuration(s: number) {
    const m = Math.ceil(s / 60);
    return `${m} phút`;
  }

  return (
    <div className="flex flex-col">
      <div className="border-b p-3 bg-muted/15">
        <Button variant="ghost" size="sm" asChild className="mb-2 h-7 gap-1 px-2 text-[10px] uppercase font-semibold text-muted-foreground hover:text-foreground">
          <Link href={courseHref}>
            <ChevronLeftIcon className="size-3" />
            Cấu trúc khóa học
          </Link>
        </Button>
        <p className="line-clamp-2 text-xs font-semibold text-foreground/90 tracking-tight leading-snug">{courseTitle}</p>
      </div>

      <div className="flex flex-col gap-3.5 p-3.5">
        {modules.map((module, moduleIndex) => {
          const moduleLessons = lessonsByModule.get(module.id) ?? [];
          if (moduleLessons.length === 0) return null;

          return (
            <section key={module.id} className="flex flex-col gap-2">
              <p className="px-1 text-[11px] font-bold text-muted-foreground/75 uppercase tracking-wider">
                {moduleIndex + 1}. {module.title}
              </p>
              <div className="flex flex-col gap-1.5">
                {moduleLessons.map((lesson) => {
                  const active = lesson.id === currentLessonId;
                  const hasVideo = !!lesson.videoStorageKey;

                  const content = (
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      {/* Left icon wrapper */}
                      <span className="shrink-0 mt-0.5">
                        {hasVideo ? (
                          active ? (
                            <PlayCircleIcon className="size-[18px] text-primary animate-pulse" />
                          ) : (
                            <FileVideoIcon className="size-[18px] text-blue-500/80 dark:text-blue-400/80" />
                          )
                        ) : (
                          <CircleDotIcon className="size-4 text-muted-foreground/60" />
                        )}
                      </span>

                      {/* Lesson title & meta info */}
                      <div className="flex flex-col gap-0.5 min-w-0 flex-1 text-left">
                        <span className={cn(
                          "text-xs truncate transition-colors",
                          active ? "font-semibold text-primary" : "font-medium text-foreground/85 group-hover:text-foreground"
                        )}>
                          Bài {lesson.orderIndex + 1}: {lesson.title.replace(/^Bài\s*\d+\s*[:.\-]\s*/i, "")}
                        </span>

                        {/* Subtitle with duration and status */}
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                          {hasVideo && lesson.durationSeconds ? (
                            <span className="flex items-center gap-0.5">
                              <ClockIcon className="size-3 shrink-0" />
                              {formatDuration(lesson.durationSeconds)}
                            </span>
                          ) : (
                            <span>Chưa tải video</span>
                          )}
                          <span>·</span>
                          {hasVideo ? (
                            <span className="text-green-600 dark:text-green-400 font-medium">Sẵn sàng</span>
                          ) : (
                            <span className="text-muted-foreground/60 italic">Bản nháp</span>
                          )}
                        </div>
                      </div>

                      {!active && <ChevronRightIcon className="size-3.5 shrink-0 opacity-40 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all mt-1" />}
                    </div>
                  );

                  return active ? (
                    <div
                      key={lesson.id}
                      className="flex items-center rounded-lg border border-primary/25 bg-primary/[0.08] dark:bg-primary/10 px-3 py-2.5 text-sm font-medium shadow-sm transition-all"
                    >
                      {content}
                    </div>
                  ) : (
                    <Link
                      key={lesson.id}
                      href={`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lesson.id}${learnSuffix}`}
                      className="flex items-center rounded-lg border border-transparent px-3 py-2.5 text-sm transition-all hover:bg-muted/50 hover:border-border/40 group"
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
