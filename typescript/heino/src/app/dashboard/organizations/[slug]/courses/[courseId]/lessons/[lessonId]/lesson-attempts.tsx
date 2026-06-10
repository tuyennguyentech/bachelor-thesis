import { Badge } from "@/components/ui/badge";
import type { StudentAttemptSummary } from "buf/gen/richter/v1/interactions_pb";

interface Props {
  attempts: StudentAttemptSummary[];
  total: number;
  maxAttempts?: number;
}

function scoreColor(score: number, max: number): string {
  if (max === 0) return "";
  const pct = score / max;
  if (pct >= 0.8) return "text-green-600 dark:text-green-400";
  if (pct >= 0.5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

function formatScore(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** Convert milliseconds to a human-readable seconds string, e.g. "12.3s". */
function formatAvgTimeMs(ms: number): string {
  if (ms <= 0) return "—";
  const secs = ms / 1000;
  return `${secs.toFixed(1)}s`;
}

/** Convert watch fraction (0..1) to a percentage string, e.g. "73%". */
function formatWatchFraction(f: number): string {
  if (f <= 0) return "0%";
  return `${Math.round(f * 100)}%`;
}

/** Return Badge variant + label for engagement score (0–100). */
function engagementBadge(score: number): { label: string; className: string } {
  if (score >= 70) {
    return {
      label: `${Math.round(score)}`,
      className:
        "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
    };
  }
  if (score >= 40) {
    return {
      label: `${Math.round(score)}`,
      className:
        "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
    };
  }
  return {
    label: `${Math.round(score)}`,
    className:
      "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  };
}

export function LessonAttempts({ attempts, total, maxAttempts }: Props) {
  if (attempts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Chưa có học viên nào nộp bài.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{total} lượt nộp</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-sans">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="text-left pb-2 font-medium">Học viên</th>
              <th className="text-left pb-2 font-medium">Email</th>
              <th className="text-center pb-2 font-medium">Số lần nộp</th>
              <th className="text-right pb-2 font-medium">Điểm</th>
              <th className="text-right pb-2 font-medium">TG trả lời TB</th>
              <th className="text-right pb-2 font-medium">% xem video</th>
              <th className="text-right pb-2 font-medium">Điểm TT</th>
              <th className="text-right pb-2 font-medium">Thời gian</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => {
              const submittedDate = a.submittedAt
                ? new Date(Number(a.submittedAt.seconds) * 1000)
                : null;
              const badge = engagementBadge(a.engagementScore);
              return (
                <tr key={a.userId} className="border-b last:border-0 hover:bg-muted/10 transition-colors">
                  <td className="py-2 pr-4 font-medium">{a.displayName}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{a.email}</td>
                  <td className="py-2 pr-4 text-center text-muted-foreground font-mono text-xs">
                    {a.attemptCount}{maxAttempts && maxAttempts > 0 ? ` / ${maxAttempts}` : ""}
                  </td>
                  <td className={`py-2 pr-4 text-right font-medium font-mono ${scoreColor(a.totalScore, a.maxScore)}`}>
                    {formatScore(a.totalScore)}/{formatScore(a.maxScore)}
                  </td>
                  <td className="py-2 pr-4 text-right text-muted-foreground text-xs font-mono">
                    {formatAvgTimeMs(a.avgTimeToAnswerMs)}
                  </td>
                  <td className="py-2 pr-4 text-right text-muted-foreground text-xs font-mono">
                    {formatWatchFraction(a.videoWatchFraction)}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {a.engagementScore > 0 ? (
                      <Badge
                        variant="outline"
                        className={`font-mono text-xs px-1.5 py-0 ${badge.className}`}
                      >
                        {badge.label}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground font-mono">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right text-muted-foreground text-xs font-mono">
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
