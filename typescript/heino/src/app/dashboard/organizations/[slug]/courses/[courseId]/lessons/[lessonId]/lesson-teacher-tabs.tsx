"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { VideoIcon, SparklesIcon, BarChart2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TeacherTab = "content" | "processing" | "results";

/**
 * Lets descendants of the tab contents (rendered server-side, passed as the
 * `content`/`processing`/`results` props) switch tabs WITHOUT a navigation —
 * e.g. the "Xử lý thủ công" CTA on the no-video placeholder. Context flows by
 * render-tree position, so a client component placed inside one of those slots
 * reads this even though it was instantiated in the server component.
 */
const LessonTabsContext = createContext<{ select: (next: TeacherTab) => void } | null>(null);

function useLessonTabs() {
  const ctx = useContext(LessonTabsContext);
  if (!ctx) throw new Error("useLessonTabs must be used within <LessonTeacherTabs>");
  return ctx;
}

/**
 * Client-side tab switcher for the teacher lesson view.
 *
 * The three tab contents are rendered ONCE on the server (passed as props) and
 * shown/hidden purely via local state — NO navigation. Previously each tab was a
 * `<Link href="?tab=...">`, so every switch re-ran the heavy lesson server
 * component (~13 richter RPCs) and queued behind any in-flight router.refresh(),
 * which under load made tab switching freeze the page ("đơ"). Since the page
 * already fetches + mounts all tab data on first load, toggling visibility
 * locally is instant and correct.
 *
 * The URL `?tab=` is kept in sync via history.replaceState (no server round-trip)
 * so deep-links / refreshes still land on the right tab (the server reads the
 * `?tab=` searchParam to pick `initialTab`).
 *
 * `content` and `processing` stay mounted (hidden via CSS) so in-flight pipeline
 * state + polling survive tab switches. `results` is mounted only while active
 * (its heatmap is heavy and has no live state to preserve).
 */
export function LessonTeacherTabs({
  initialTab,
  resultsTotal,
  content,
  processing,
  results,
}: {
  initialTab: TeacherTab;
  resultsTotal: number;
  content: ReactNode;
  processing: ReactNode;
  results: ReactNode;
}) {
  const [tab, setTab] = useState<TeacherTab>(initialTab);

  // Sync to `initialTab` when a real navigation lands on this SAME lesson with a
  // different `?tab=` (deep-link/refresh that reconciles in place, or any
  // remaining `<Link href="?tab=">`). React keeps the same component instance,
  // so `useState(initialTab)` is read only on first mount; without this effect
  // the visible tab would stay stale and the user would have to hard-refresh.
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  function select(next: TeacherTab) {
    setTab(next);
    // Keep the URL shareable without a navigation / server re-render.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url.toString());
    }
  }

  const tabs: Array<[TeacherTab, string, typeof VideoIcon]> = [
    ["content", "Bài giảng", VideoIcon],
    ["processing", "Xử lý video", SparklesIcon],
    ["results", "Kết quả & Thống kê", BarChart2Icon],
  ];

  return (
    <LessonTabsContext.Provider value={{ select }}>
      <div className="flex border-b border-muted">
        {tabs.map(([key, label, Icon]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => select(key)}
              data-testid={`lesson-tab-${key}`}
              className={cn(
                "-mb-[2px] flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {label}
              {key === "results" && resultsTotal > 0 && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                  {resultsTotal}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* content + processing always mounted (CSS-hidden) so pipeline/polling
          state survives tab switches; results mounted only while active. */}
      <div className={tab !== "content" ? "hidden" : "flex w-full flex-col items-stretch gap-6 animate-in fade-in duration-200"}>
        {content}
      </div>
      <div className={tab !== "processing" ? "hidden" : "flex w-full flex-col items-stretch gap-6 animate-in fade-in duration-200"}>
        {processing}
      </div>
      {tab === "results" && (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200">{results}</div>
      )}
    </LessonTabsContext.Provider>
  );
}

/**
 * "Xử lý thủ công" CTA on the no-video placeholder. Switches to the processing
 * tab via client state (no navigation). The old `<Link href="?tab=processing">`
 * did a full RSC navigation that re-ran ~13 richter RPCs AND — because the tab
 * state is now client-side `useState` that isn't remounted on a same-lesson
 * navigation — failed to update the visible tab at all (the "must refresh"
 * wedge, worst under concurrent pipeline load). A pure client toggle is instant
 * and reliable.
 */
export function SwitchToProcessingButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { select } = useLessonTabs();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={() => select("processing")}
      data-testid="manual-processing-cta"
    >
      {children}
    </Button>
  );
}
