import Link from "next/link";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BookOpenCheckIcon,
  TrendingUpIcon,
} from "lucide-react";
import type { MyCourseProgress } from "buf/gen/richter/v1/interactions_pb";

interface StudentProgressSectionProps {
  courses: MyCourseProgress[];
  errorMsg?: string;
}

// courseHref deep-links a progress card to its course. org_slug comes from the
// ListMyCourseProgress RPC; a student lands on the learner view at the bare URL
// (no ?mode=learn — that flag is only for managers previewing as a student).
function courseHref(c: MyCourseProgress): string | null {
  if (!c.orgSlug || !c.courseId) return null;
  return `/dashboard/organizations/${c.orgSlug}/courses/${c.courseId}`;
}

export function StudentProgressSection({ courses, errorMsg }: StudentProgressSectionProps) {
  const totalDone = courses.reduce((sum, c) => sum + c.lessonsDone, 0);
  // Weighted average score: weight each course by the lessons done there, so a
  // 1-lesson course doesn't count as much as a 10-lesson one.
  const avgScore =
    totalDone > 0
      ? courses.reduce((sum, c) => sum + c.avgScore * c.lessonsDone, 0) / totalDone
      : 0;
  const avgScorePct = Math.round(avgScore * 100);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Tiến độ học tập của tôi</h2>
        {courses.length > 0 && (
          <Link
            href="/dashboard/organizations"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Tất cả tổ chức
            <ArrowRightIcon className="size-3.5" />
          </Link>
        )}
      </div>

      {/* Summary stats — a compact pair, distinct from the course grid below. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <BookOpenCheckIcon className="size-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Bài học đã hoàn thành</p>
            <p className="text-2xl font-semibold tabular-nums leading-tight">{totalDone}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <TrendingUpIcon className="size-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Điểm trung bình</p>
            <p className="text-2xl font-semibold tabular-nums leading-tight">
              {courses.length > 0 ? `${avgScorePct}%` : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* Course progress grid — scales to many courses, each card deep-links. */}
      {errorMsg ? (
        <div className="rounded-lg border px-4 py-6 text-center text-sm text-destructive">
          {errorMsg}
        </div>
      ) : courses.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-12 text-center">
          <p className="text-sm font-medium">Chưa có dữ liệu học tập</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Hoàn thành ít nhất một bài học để theo dõi tiến độ tại đây.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {courses.map((c) => (
            <CourseProgressCard key={c.courseId} course={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function CourseProgressCard({ course: c }: { course: MyCourseProgress }) {
  const pct = c.lessonsTotal > 0 ? Math.round((c.lessonsDone / c.lessonsTotal) * 100) : 0;
  const scorePct = Math.round(c.avgScore * 100);
  const href = courseHref(c);
  const complete = c.lessonsTotal > 0 && c.lessonsDone >= c.lessonsTotal;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug" data-slot="card-title">
          {c.title}
        </h3>
        {href && (
          <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground/70 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {c.lessonsDone}/{c.lessonsTotal} bài học
          </span>
          <span className="text-sm font-semibold tabular-nums">{pct}%</span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`Tiến độ ${c.title}`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-all ${complete ? "bg-emerald-500" : "bg-primary"}`}
            style={{ width: `${Math.max(pct, 3)}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          {c.lessonsDone > 0 ? (
            <span className="text-xs text-muted-foreground">
              Điểm TB <span className="font-medium text-foreground tabular-nums">{scorePct}%</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Chưa có điểm</span>
          )}
          {href && (
            <span className="text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
              {complete ? "Xem lại" : "Tiếp tục học"}
            </span>
          )}
        </div>
      </div>
    </>
  );

  const cardClass =
    "group relative flex min-h-[8.5rem] flex-col gap-3 rounded-lg border bg-card p-4";

  if (!href) {
    return (
      <div className={cardClass} data-slot="card">
        {body}
      </div>
    );
  }
  return (
    <Link
      href={href}
      data-slot="card"
      className={`${cardClass} transition-all hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {body}
    </Link>
  );
}
