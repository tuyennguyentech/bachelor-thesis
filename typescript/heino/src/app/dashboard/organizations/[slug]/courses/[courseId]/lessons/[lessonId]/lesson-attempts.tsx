import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Học viên</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="text-center">Số lần nộp</TableHead>
              <TableHead className="text-right">Điểm</TableHead>
              <TableHead className="text-right">TG trả lời TB</TableHead>
              <TableHead className="text-right">% xem video</TableHead>
              <TableHead className="text-right">Điểm TT</TableHead>
              <TableHead className="text-right">Thời gian</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attempts.map((a) => {
              const submittedDate = a.submittedAt
                ? new Date(Number(a.submittedAt.seconds) * 1000)
                : null;
              const badge = engagementBadge(a.engagementScore);
              return (
                <TableRow key={a.userId}>
                  <TableCell className="font-medium">{a.displayName}</TableCell>
                  <TableCell className="text-muted-foreground">{a.email}</TableCell>
                  <TableCell className="text-center text-muted-foreground font-mono text-xs">
                    {a.attemptCount}{maxAttempts && maxAttempts > 0 ? ` / ${maxAttempts}` : ""}
                  </TableCell>
                  <TableCell className={`text-right font-medium font-mono ${scoreColor(a.totalScore, a.maxScore)}`}>
                    {formatScore(a.totalScore)}/{formatScore(a.maxScore)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs font-mono">
                    {formatAvgTimeMs(a.avgTimeToAnswerMs)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs font-mono">
                    {formatWatchFraction(a.videoWatchFraction)}
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs font-mono">
                    {submittedDate
                      ? submittedDate.toLocaleString("vi-VN", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
