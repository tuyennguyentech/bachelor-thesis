import { createRichterClient } from "@/lib/connect-client";
import { InteractionService, type CourseStudentSummary } from "buf/gen/richter/v1/interactions_pb";
import { formatDate } from "@/lib/date-utils";
import { engagementBadge } from "@/lib/engagement-utils";
import { toUserMessage } from "@/lib/connect-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/pagination";
import { AlertTriangleIcon, BarChart2Icon } from "lucide-react";

const LIMIT = 20;

interface CourseResultsProps {
  courseId: string;
  token: string;
  page?: number;
}


export async function CourseResults({ courseId, token, page = 1 }: CourseResultsProps) {
  const client = createRichterClient(InteractionService, token);
  const currentPage = Math.max(1, page);
  let students: CourseStudentSummary[] = [];
  let loadError: string | null = null;
  try {
    const res = await client.listCourseAttemptsSummary({
      courseId,
      limit: LIMIT,
      offset: (currentPage - 1) * LIMIT,
    });
    students = res.students ?? [];
  } catch (err) {
    loadError = toUserMessage(err, "Không thể tải dữ liệu kết quả học tập.");
  }

  const hasNext = students.length === LIMIT;

  // Summary metrics computed from the current page's rows.
  const activeCount = students.filter((s) => !!s.lastActive).length;
  const avgProgressPct =
    students.length > 0
      ? Math.round(
          (students.reduce(
            (acc, s) =>
              acc + (s.lessonsTotal > 0 ? s.lessonsCompleted / s.lessonsTotal : 0),
            0,
          ) /
            students.length) *
            100,
        )
      : 0;
  const scored = students.filter((s) => !!s.lastActive);
  const avgClassScorePct =
    scored.length > 0
      ? Math.round(
          (scored.reduce((acc, s) => acc + s.avgScore, 0) / scored.length) * 100,
        )
      : null;

  return (
    <div className="flex flex-col gap-4">
      {!loadError && students.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          <div className="rounded-md border bg-background px-3 py-2">
            <span className="text-muted-foreground">Học viên hoạt động: </span>
            <span className="font-medium tabular-nums">
              {activeCount}/{students.length}
            </span>
          </div>
          <div className="rounded-md border bg-background px-3 py-2">
            <span className="text-muted-foreground">Hoàn thành TB: </span>
            <span className="font-medium tabular-nums">{avgProgressPct}%</span>
          </div>
          <div className="rounded-md border bg-background px-3 py-2">
            <span className="text-muted-foreground">Điểm TB lớp: </span>
            <span className="font-medium tabular-nums">
              {avgClassScorePct !== null ? `${avgClassScorePct}%` : "—"}
            </span>
          </div>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Học viên</TableHead>
              <TableHead>Tiến độ</TableHead>
              <TableHead>Điểm TB</TableHead>
              <TableHead>Tương tác</TableHead>
              <TableHead>Hoạt động gần nhất</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadError ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={<AlertTriangleIcon className="size-5" />}
                    title="Không thể tải dữ liệu"
                    description={loadError}
                  />
                </TableCell>
              </TableRow>
            ) : students.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={<BarChart2Icon className="size-5" />}
                    title="Chưa có dữ liệu"
                    description="Chưa có học viên nào nộp bài trong khóa học này."
                  />
                </TableCell>
              </TableRow>
            ) : (
              students.map((s) => {
                const hasAttempt = !!s.lastActive;
                const progress =
                  s.lessonsTotal > 0
                    ? `${s.lessonsCompleted}/${s.lessonsTotal}`
                    : `${s.lessonsCompleted}/—`;
                const progressPct =
                  s.lessonsTotal > 0
                    ? Math.round((s.lessonsCompleted / s.lessonsTotal) * 100)
                    : null;
                const avgScorePct = Math.round(s.avgScore * 100);
                const isZeroProgress = (progressPct ?? 0) === 0;

                return (
                  <TableRow
                    key={s.userId}
                    className={isZeroProgress ? "text-muted-foreground" : undefined}
                  >
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          {s.displayName || s.userId}
                        </span>
                        {s.email && (
                          <span className="text-xs text-muted-foreground">{s.email}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-sm tabular-nums">{progress}</span>
                        {progressPct !== null && (
                          <>
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {progressPct}%
                            </span>
                          </>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {hasAttempt ? `${avgScorePct}%` : "—"}
                    </TableCell>
                    <TableCell>
                      {hasAttempt ? (
                        engagementBadge(s.engagementScore)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.lastActive ? formatDate(s.lastActive) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {!loadError && (
        <Pagination
          page={currentPage}
          hasNext={hasNext}
          buildHref={(p) => `?tab=results&page=${p}`}
        />
      )}
    </div>
  );
}
