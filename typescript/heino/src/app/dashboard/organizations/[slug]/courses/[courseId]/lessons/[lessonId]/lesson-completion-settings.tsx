"use client";

import { useState, useTransition } from "react";
import { CheckCircle2Icon, Loader2Icon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateLessonCompletionAction } from "./actions";

interface Props {
  lessonId: string;
  title: string;
  description: string;
  orderIndex: number;
  language: string;
  maxAttempts: number;
  /** lesson.minWatchFraction (0..1); 0 means "use default". */
  minWatchFraction: number;
  /** lesson.minScoreFraction (0..1); 0 means "use default". */
  minScoreFraction: number;
}

const DEFAULT_WATCH_PCT = 80;
const DEFAULT_SCORE_PCT = 60;

/** Convert a stored fraction (0..1) to a whole percent, treating 0 as the default. */
function toPercent(fraction: number, fallback: number): number {
  if (!fraction || fraction <= 0) return fallback;
  return Math.round(fraction * 100);
}

function clampPct(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

/**
 * Teacher-facing control for a lesson's completion criteria: the minimum
 * fraction of video watched and the minimum score (as percentages). Persists
 * via {@link updateLessonCompletionAction}, mirroring the feedback-mode save.
 */
export function LessonCompletionSettings({
  lessonId,
  title,
  description,
  orderIndex,
  language,
  maxAttempts,
  minWatchFraction,
  minScoreFraction,
}: Props) {
  const [watchPct, setWatchPct] = useState(() =>
    toPercent(minWatchFraction, DEFAULT_WATCH_PCT),
  );
  const [scorePct, setScorePct] = useState(() =>
    toPercent(minScoreFraction, DEFAULT_SCORE_PCT),
  );
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    setSaved(false);
    setError(null);
    startTransition(async () => {
      const res = await updateLessonCompletionAction({
        lessonId,
        title,
        description,
        orderIndex,
        language,
        maxAttempts,
        minWatchFraction: clampPct(watchPct) / 100,
        minScoreFraction: clampPct(scorePct) / 100,
      });
      if (res.ok) {
        setSaved(true);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="rounded-md border bg-background p-4">
      <h3 className="text-sm font-medium">Điều kiện hoàn thành</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Học viên cần đạt cả hai mốc dưới đây để bài học được tính là hoàn thành.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="min-watch-pct" className="text-xs">
            Xem video tối thiểu (%)
          </Label>
          <input
            id="min-watch-pct"
            type="number"
            min={0}
            max={100}
            step={5}
            value={watchPct}
            disabled={pending}
            onChange={(e) => setWatchPct(clampPct(Number(e.target.value)))}
            className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="min-score-pct" className="text-xs">
            Điểm tối thiểu (%)
          </Label>
          <input
            id="min-score-pct"
            type="number"
            min={0}
            max={100}
            step={5}
            value={scorePct}
            disabled={pending}
            onChange={(e) => setScorePct(clampPct(Number(e.target.value)))}
            className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
          />
        </div>
        <Button type="button" onClick={handleSave} disabled={pending} className="gap-2">
          {pending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <SaveIcon className="size-4" />
          )}
          Lưu
        </Button>
        {saved && !pending && (
          <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2Icon className="size-3.5" />
            Đã lưu
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
