"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  LayoutDashboardIcon,
  BookOpenIcon,
  UsersIcon,
  BarChart2Icon,
  ChevronLeftIcon,
  GraduationCapIcon,
  UserCheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CourseTab = "overview" | "lessons" | "members" | "results" | "join-requests";

interface CourseWorkspaceShellProps {
  slug: string;
  courseTitle: string;
  activeTab: CourseTab;
  canManage: boolean;
  /** Preserve the course-level "learn" signal across tab navigation. */
  mode?: "learn" | "manage";
  children: ReactNode;
}

interface TabItem {
  id: CourseTab;
  label: string;
  icon: React.ElementType;
  managerOnly: boolean;
}

const TAB_ITEMS: TabItem[] = [
  { id: "overview", label: "Tổng quan", icon: LayoutDashboardIcon, managerOnly: false },
  { id: "lessons", label: "Bài học", icon: BookOpenIcon, managerOnly: false },
  { id: "members", label: "Thành viên", icon: UsersIcon, managerOnly: false },
  { id: "join-requests", label: "Duyệt yêu cầu", icon: UserCheckIcon, managerOnly: true },
  { id: "results", label: "Kết quả học tập", icon: BarChart2Icon, managerOnly: true },
];

export function CourseWorkspaceSidebar({
  slug,
  courseTitle,
  activeTab,
  canManage,
  mode,
}: Omit<CourseWorkspaceShellProps, "children">) {
  const visibleTabs = TAB_ITEMS.filter((t) => !t.managerOnly || canManage);
  const orgCoursesHref = `/dashboard/organizations/${slug}/courses`;
  const modeSuffix = mode === "learn" ? "&mode=learn" : "";
  const tabHref = (id: CourseTab) => `?tab=${id}${modeSuffix}`;

  return (
    <>
      {/* Mobile: horizontal scrollable tab strip (below md). Must NOT use
          basis-full — the parent is flex-col on mobile, so basis-full would make
          this nav take the full column height and hide <main> entirely. */}
      <nav
        className="flex w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1 md:hidden"
        aria-label="Course tabs"
      >
        {visibleTabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <Link
              key={id}
              href={tabHref(id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
              data-tab={id}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      <aside
        className="hidden w-[260px] shrink-0 flex-col border-r bg-card/40 overflow-y-auto md:flex"
        aria-label="Course workspace sidebar"
      >
      {/* Back button + course title */}
      <div className="border-b p-3">
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="mb-2 h-7 gap-1 px-2 text-[11px] uppercase font-semibold text-muted-foreground hover:text-foreground"
        >
          <Link href={orgCoursesHref}>
            <ChevronLeftIcon className="size-3" />
            Danh sách khóa học
          </Link>
        </Button>
        <div className="flex min-w-0 items-start gap-2 px-1">
          <GraduationCapIcon className="size-4 shrink-0 mt-0.5 text-primary" />
          <p className="line-clamp-2 truncate text-xs font-semibold text-foreground/90 tracking-tight leading-snug">
            {courseTitle}
          </p>
        </div>
      </div>

      {/* Navigation tabs */}
      <nav className="flex flex-col gap-0.5 p-2" aria-label="Course tabs">
        {visibleTabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <Link
              key={id}
              href={tabHref(id)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
              data-tab={id}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
      </aside>
    </>
  );
}
