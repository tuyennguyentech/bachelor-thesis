import { BookOpenCheckIcon, TrendingUpIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MyCourseProgress } from "buf/gen/richter/v1/interactions_pb";

interface StudentProgressSectionProps {
  courses: MyCourseProgress[];
  errorMsg?: string;
}

export function StudentProgressSection({ courses, errorMsg }: StudentProgressSectionProps) {
  const totalDone = courses.reduce((sum, c) => sum + c.lessonsDone, 0);
  // Weighted average score: weight each course by the number of lessons the student
  // has done in that course.  An unweighted mean would let a course with 1 completed
  // lesson dominate the score equally as a 10-lesson course.
  // TODO(backend): for a precise weighted avg we need per-course question totals from
  // the API (lessonsDone is the best proxy available without a proto change).
  const totalWeight = courses.reduce((sum, c) => sum + c.lessonsDone, 0);
  const avgScore =
    totalWeight > 0
      ? courses.reduce((sum, c) => sum + c.avgScore * c.lessonsDone, 0) / totalWeight
      : 0;
  const avgScorePct = Math.round(avgScore * 100);

  return (
    <>
      {/* Student-specific stat cards */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BookOpenCheckIcon className="size-4" />
            Bài học đã hoàn thành
          </div>
          <p className="mt-2 text-2xl font-semibold">{totalDone}</p>
        </div>
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <TrendingUpIcon className="size-4" />
            Điểm trung bình
          </div>
          <p className="mt-2 text-2xl font-semibold">
            {courses.length > 0 ? `${avgScorePct}%` : "—"}
          </p>
        </div>
      </div>

      {/* Course progress list */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Tiến độ học tập của tôi</h2>
        {errorMsg ? (
          <div className="rounded-md border px-4 py-6 text-center text-sm text-destructive">
            {errorMsg}
          </div>
        ) : courses.length === 0 ? (
          <div className="rounded-md border px-4 py-10 text-center">
            <p className="text-sm font-medium">Chưa có dữ liệu học tập</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Hoàn thành ít nhất một bài học để xem tiến độ ở đây.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {courses.map((c) => {
              const pct =
                c.lessonsTotal > 0
                  ? Math.round((c.lessonsDone / c.lessonsTotal) * 100)
                  : 0;
              const scorePct = Math.round(c.avgScore * 100);
              return (
                <Card key={c.courseId} size="sm" className="gap-3">
                  <CardHeader className="pb-0 pt-0">
                    <CardTitle className="text-sm font-medium leading-snug">
                      {c.title}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 pb-0">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {c.lessonsDone}/{c.lessonsTotal} bài học
                      </span>
                      <span>{pct}%</span>
                    </div>
                    {/* Tailwind progress bar — shadcn `progress` not installed */}
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {c.lessonsDone > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Điểm TB: <span className="font-medium text-foreground">{scorePct}%</span>
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
