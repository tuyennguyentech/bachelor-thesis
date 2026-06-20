"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FlameIcon, ListChecksIcon, TableIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ResultsSubTab = "heatmap" | "table" | "questions";

const SUB_TABS: Array<[ResultsSubTab, string, typeof TableIcon]> = [
  ["table", "Bảng kết quả", TableIcon],
  ["heatmap", "Bản đồ nhiệt", FlameIcon],
  ["questions", "Phân tích câu hỏi", ListChecksIcon],
];

/**
 * Nested sub-tabs for the lesson "Kết quả & Thống kê" tab. The single tab used to
 * stack the heatmap, the attempts table, and the per-question analytics together —
 * a wall of scrolling. This splits them into three focused views.
 *
 * Like the parent LessonTeacherTabs, the three panels are rendered ONCE on the
 * server (passed as props) and toggled with local state — no navigation, no RPC
 * re-run. Only the active panel is mounted (none holds live state). The `?sub=`
 * query is synced via history.replaceState so a sub-view is deep-linkable.
 *
 * A segmented control (vs the parent's underline tabs) signals the subordinate
 * hierarchy. The optional `banner` (the "needs attention" summary) sits above the
 * control so the teacher's act-on-this cue is visible from every sub-view.
 */
export function LessonResultsTabs({
  initialSub,
  banner,
  heatmap,
  table,
  questions,
}: {
  initialSub: ResultsSubTab;
  banner?: ReactNode;
  heatmap: ReactNode;
  table: ReactNode;
  questions: ReactNode;
}) {
  const [sub, setSub] = useState<ResultsSubTab>(initialSub);

  useEffect(() => {
    setSub(initialSub);
  }, [initialSub]);

  function select(next: ResultsSubTab) {
    setSub(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("sub", next);
      window.history.replaceState(null, "", url.toString());
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {banner}

      <div
        role="tablist"
        aria-label="Chế độ xem kết quả"
        className="inline-flex items-center gap-1 self-start rounded-lg border bg-muted/40 p-1"
      >
        {SUB_TABS.map(([key, label, Icon]) => {
          const active = sub === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => select(key)}
              data-testid={`lesson-results-subtab-${key}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="animate-in fade-in duration-200">
        {sub === "table" && table}
        {sub === "heatmap" && heatmap}
        {sub === "questions" && questions}
      </div>
    </div>
  );
}
