import type { StudentAttemptResult } from "buf/gen/richter/v1/quiz_pb";

interface Props {
  attempts: StudentAttemptResult[];
  total: number;
}

function scoreColor(score: number, total: number): string {
  if (total === 0) return "";
  const pct = score / total;
  if (pct >= 0.8) return "text-green-600 dark:text-green-400";
  if (pct >= 0.5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

export function LessonAttempts({ attempts, total }: Props) {
  if (attempts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Chưa có học viên nào nộp bài.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{total} lượt nộp</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="text-left pb-2 font-medium">Học viên</th>
              <th className="text-left pb-2 font-medium">Email</th>
              <th className="text-right pb-2 font-medium">Điểm</th>
              <th className="text-right pb-2 font-medium">Thời gian</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => {
              const submittedDate = a.submittedAt
                ? new Date(Number(a.submittedAt.seconds) * 1000)
                : null;
              return (
                <tr key={a.userId} className="border-b last:border-0">
                  <td className="py-2 pr-4">{a.displayName}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{a.email}</td>
                  <td className={`py-2 pr-4 text-right font-medium ${scoreColor(a.score, a.total)}`}>
                    {a.score}/{a.total}
                  </td>
                  <td className="py-2 text-right text-muted-foreground text-xs">
                    {submittedDate
                      ? submittedDate.toLocaleString("vi-VN", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
