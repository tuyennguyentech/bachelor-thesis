import { createRichterClient } from "@/lib/connect-client";
import { InteractionService, type CourseStudentSummary } from "buf/gen/richter/v1/interactions_pb";
import { formatDate } from "@/lib/date-utils";
import { engagementBadge } from "@/lib/engagement-utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { BarChart2Icon } from "lucide-react";

interface CourseResultsProps {
  courseId: string;
  token: string;
}


export async function CourseResults({ courseId, token }: CourseResultsProps) {
  const client = createRichterClient(InteractionService, token);
  let students: CourseStudentSummary[] = [];
  try {
    const res = await client.listCourseAttemptsSummary({
      courseId,
      limit: 100,
      offset: 0,
    });
    students = res.students ?? [];
  } catch {
    students = [];
  }

  return (
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
          {students.length === 0 ? (
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
              const progress =
                s.lessonsTotal > 0
                  ? `${s.lessonsCompleted}/${s.lessonsTotal}`
                  : `${s.lessonsCompleted}/—`;
              const progressPct =
                s.lessonsTotal > 0
                  ? Math.round((s.lessonsCompleted / s.lessonsTotal) * 100)
                  : null;
              const avgScorePct = Math.round(s.avgScore * 100);

              return (
                <TableRow key={s.userId}>
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
                        <span className="text-xs text-muted-foreground">({progressPct}%)</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {s.lessonsCompleted > 0 ? `${avgScorePct}%` : "—"}
                  </TableCell>
                  <TableCell>
                    {s.lessonsCompleted > 0 ? engagementBadge(s.engagementScore) : <span className="text-muted-foreground">—</span>}
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
  );
}
