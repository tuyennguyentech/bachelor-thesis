import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  StudentAttemptSummary,
  KindAccuracy,
  McqInteractionStats,
} from "buf/gen/richter/v1/interactions_pb";

interface Props {
  attempts: StudentAttemptSummary[];
  total: number;
  maxAttempts?: number;
  perKind?: KindAccuracy[];
  questions?: McqInteractionStats[];
}

/** Vietnamese label + accent colour per DB interaction-kind string. */
const KIND_LABELS: Record<string, { label: string; color: string }> = {
  mcq: { label: "MCQ 1 đáp án", color: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400" },
  multiple_choice: { label: "MCQ nhiều đáp án", color: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400" },
  fill_blank: { label: "Điền đáp án", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" },
  reading: { label: "Bài đọc", color: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400" },
  listening: { label: "Bài nghe", color: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400" },
};

function kindLabel(kind: string): { label: string; color: string } {
  return (
    KIND_LABELS[kind] ?? {
      label: kind,
      color: "bg-muted text-muted-foreground",
    }
  );
}

function scoreColor(score: number, max: number): string {
  if (max === 0) return "";
  const pct = score / max;
  if (pct >= 0.8) return "text-green-600 dark:text-green-400";
  if (pct >= 0.5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

/** Same thresholds as scoreColor but for a 0..1 ratio directly. */
function ratioColor(ratio: number): string {
  if (ratio >= 0.8) return "text-green-600 dark:text-green-400";
  if (ratio >= 0.5) return "text-yellow-600 dark:text-yellow-400";
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

/** Convert a total time-on-task in ms to "Mm Ss" or "Ss". */
function formatTimeOnTaskMs(ms: number): string {
  if (ms <= 0) return "—";
  const totalSecs = Math.round(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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

/** A per-kind accuracy pill strip, styled like exercise-overview's KIND_BADGES. */
function KindAccuracyStrip({ perKind }: { perKind: KindAccuracy[] }) {
  const shown = perKind.filter((k) => k.responseCount > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="kind-accuracy-strip">
      {shown.map((k) => {
        const { label, color } = kindLabel(k.kind);
        return (
          <span
            key={k.kind}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${color}`}
          >
            {label}
            <span className="rounded-full bg-background/50 px-1.5 py-0.5 text-xs font-bold">
              {Math.round(k.accuracy * 100)}%
            </span>
            <span className="text-[10px] opacity-70">({k.responseCount})</span>
          </span>
        );
      })}
    </div>
  );
}

/** Cards of MCQ questions with per-option answer distribution bars. */
function QuestionAnalysisPanel({ questions }: { questions: McqInteractionStats[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="question-analysis">
      <h3 className="text-sm font-medium">Phân tích câu hỏi</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {questions.map((q) => {
          const totalChosen = q.options.reduce((acc, o) => acc + o.chosenCount, 0);
          const correctChosen = q.options
            .filter((o) => o.isCorrect)
            .reduce((acc, o) => acc + o.chosenCount, 0);
          const accuracy = totalChosen > 0 ? correctChosen / totalChosen : 0;
          return (
            <div key={q.interactionId} className="rounded-md border bg-background p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium leading-snug">{q.prompt}</p>
                <span
                  className={`shrink-0 font-mono text-xs font-semibold ${ratioColor(accuracy)}`}
                >
                  {Math.round(accuracy * 100)}%
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {q.options.map((o) => {
                  const sharePct =
                    totalChosen > 0 ? Math.round((o.chosenCount / totalChosen) * 100) : 0;
                  // Red emphasis when a wrong option attracts a large share of answers.
                  const highWrong = !o.isCorrect && sharePct >= 30;
                  const barColor = o.isCorrect
                    ? "bg-green-500/70"
                    : highWrong
                      ? "bg-red-500/70"
                      : "bg-muted-foreground/30";
                  return (
                    <div key={o.optionIndex} className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span
                          className={`truncate ${
                            o.isCorrect ? "font-medium text-green-700 dark:text-green-400" : ""
                          }`}
                        >
                          {o.optionText}
                        </span>
                        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                          {o.chosenCount} · {sharePct}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${barColor}`}
                          style={{ width: `${sharePct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LessonAttempts({ attempts, total, maxAttempts, perKind, questions }: Props) {
  if (attempts.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {perKind && perKind.length > 0 && <KindAccuracyStrip perKind={perKind} />}
        <p className="text-sm text-muted-foreground">Chưa có học viên nào nộp bài.</p>
        {questions && questions.length > 0 && (
          <QuestionAnalysisPanel questions={questions} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {perKind && perKind.length > 0 && <KindAccuracyStrip perKind={perKind} />}

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
                <TableHead className="text-right">Tỉ lệ trả lời</TableHead>
                <TableHead className="text-right">TG trả lời TB</TableHead>
                <TableHead className="text-right">Tổng TG làm</TableHead>
                <TableHead className="text-right">Nghe lại TB</TableHead>
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
                    <TableCell className={`text-right text-xs font-mono ${ratioColor(a.responseRate)}`}>
                      {Math.round(a.responseRate * 100)}%
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs font-mono">
                      {formatAvgTimeMs(a.avgTimeToAnswerMs)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs font-mono">
                      {formatTimeOnTaskMs(a.timeOnTaskMs)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs font-mono">
                      {a.avgReplayCount.toFixed(1)}
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

      {questions && questions.length > 0 && (
        <QuestionAnalysisPanel questions={questions} />
      )}
    </div>
  );
}
