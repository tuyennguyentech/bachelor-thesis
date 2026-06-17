import Link from "next/link";
import { createRichterClient } from "@/lib/connect-client";
import { InteractionService, type CourseStudentSummary } from "buf/gen/richter/v1/interactions_pb";
import { Button } from "@/components/ui/button";
import { ActivityIcon, ChevronRightIcon, AlertTriangleIcon } from "lucide-react";
import { InfoHint } from "@/components/ui/info-hint";

interface CourseClassPulseProps {
  courseId: string;
  token: string;
  slug: string;
  /** Total enrolled members, to frame participation (e.g. "12/20 đã tham gia"). */
  totalMembers: number;
}

/** Average over rows of (numerator/lessonsTotal), as a 0..100 percent. */
function avgPct(
  rows: CourseStudentSummary[],
  pick: (r: CourseStudentSummary) => number,
): number {
  if (rows.length === 0) return 0;
  const sum = rows.reduce(
    (acc, r) => acc + (r.lessonsTotal > 0 ? pick(r) / r.lessonsTotal : 0),
    0,
  );
  return Math.round((sum / rows.length) * 100);
}

/**
 * Manager-only "class pulse" for the course overview: a compact, at-a-glance
 * engagement summary (participation, average progress, students needing
 * attention) that links through to the full Kết quả học tập tab. Fetches
 * the same enriched per-student summary used by the results tab; renders nothing
 * on error so a flaky analytics call never breaks the overview.
 */
export async function CourseClassPulse({
  courseId,
  token,
  slug,
  totalMembers,
}: CourseClassPulseProps) {
  const client = createRichterClient(InteractionService, token);
  let students;
  let participants;
  try {
    const res = await client.listCourseAttemptsSummary({
      courseId,
      limit: 100,
      offset: 0,
    });
    students = res.students ?? [];
    // total counts every student with ≥1 attempt; the rows are a (≤100) sample
    // used only for the averages, which is plenty for an at-a-glance pulse.
    participants = Number(res.total) || students.length;
  } catch (err) {
    console.error("[class-pulse] listCourseAttemptsSummary failed:", err);
    return null;
  }

  const resultsHref = `/dashboard/organizations/${slug}/courses/${courseId}?tab=results`;

  if (students.length === 0) {
    return (
      <div className="rounded-md border bg-background p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ActivityIcon className="size-4" />
          <span>Chưa có học viên nào làm bài. Số liệu lớp học sẽ hiện ở đây.</span>
        </div>
      </div>
    );
  }

  const avgProgressPct = avgPct(students, (s) => s.lessonsCompleted);
  // "Needs attention" mirrors the results table's flag: a low average score or a
  // weak engagement signal among students who have actually attempted.
  const needAttention = students.filter(
    (s) => s.avgScore < 0.5 || s.engagementScore < 40,
  ).length;

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-violet-500" />
          <h2 className="font-medium">Nhịp độ lớp học</h2>
        </div>
        <Button variant="ghost" size="sm" asChild className="gap-1 text-muted-foreground">
          <Link href={resultsHref}>
            Xem chi tiết
            <ChevronRightIcon className="size-4" />
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-background p-3">
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            Đã tham gia
            <InfoHint text="Số học viên đã làm ít nhất một bài, trên tổng số thành viên khóa học." />
          </p>
          <p className="mt-1 text-xl font-bold tabular-nums">
            {participants}
            {totalMembers > 0 && (
              <span className="text-sm font-normal text-muted-foreground">/{totalMembers}</span>
            )}
          </p>
        </div>
        <div className="rounded-lg border bg-background p-3">
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            Tiến độ TB
            <InfoHint text="Tiến độ trung bình của lớp: tỉ lệ bài đã hoàn thành trên tổng số bài." />
          </p>
          <p className="mt-1 text-xl font-bold tabular-nums">{avgProgressPct}%</p>
        </div>
        <Link
          href={resultsHref}
          className={`rounded-lg border p-3 transition-colors ${
            needAttention > 0
              ? "border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/20"
              : "bg-background hover:bg-muted/50"
          }`}
        >
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {needAttention > 0 && <AlertTriangleIcon className="size-3 text-red-500" />}
            Cần chú ý
            <InfoHint text="Số học viên có điểm dưới 50% hoặc tương tác dưới 40 — nên theo dõi và hỗ trợ." />
          </p>
          <p
            className={`mt-1 text-xl font-bold tabular-nums ${
              needAttention > 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {needAttention}
          </p>
        </Link>
      </div>
    </div>
  );
}

/** Skeleton shown while the pulse's analytics call is in flight (Suspense fallback). */
export function CourseClassPulseSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm flex flex-col gap-3">
      <div className="h-5 w-32 rounded bg-muted animate-pulse" />
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-background p-3">
            <div className="h-3 w-16 rounded bg-muted animate-pulse" />
            <div className="mt-2 h-6 w-10 rounded bg-muted animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
