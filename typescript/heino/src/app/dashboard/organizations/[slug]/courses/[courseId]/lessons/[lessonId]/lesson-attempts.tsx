import { Badge } from "@/components/ui/badge";
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react";
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
  QuestionStat,
} from "buf/gen/richter/v1/interactions_pb";
import { formatScore } from "@/lib/format";
import { ScoreBar } from "@/components/score-viz";
import { InfoHint } from "@/components/ui/info-hint";

interface Props {
  attempts: StudentAttemptSummary[];
  total: number;
  maxAttempts?: number;
  perKind?: KindAccuracy[];
  questions?: QuestionStat[];
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

// Below this composite engagement score (0–100) a student is flagged as needing
// attention — matches the backend `engagementWarnThreshold`.
const ENGAGEMENT_WARN = 40;
// A question whose class accuracy is below this is "hard" — matches the backend
// heatmap gap threshold.
const HARD_QUESTION_THRESHOLD = 0.6;

/**
 * A one-glance "what to act on" band. Answers the teacher's first question —
 * who is struggling and which question is hardest — without scanning every row.
 * Computed from the already-loaded attempts + question stats (no extra request).
 */
function NeedsAttentionBand({
  attempts,
  questions,
}: {
  attempts: StudentAttemptSummary[];
  questions: QuestionStat[];
}) {
  const atRisk = attempts.filter((a) => a.engagementScore < ENGAGEMENT_WARN);
  const hardest = questions
    .filter((q) => q.responseCount > 0 && q.accuracy < HARD_QUESTION_THRESHOLD)
    .sort((a, b) => a.accuracy - b.accuracy)[0];

  if (atRisk.length === 0 && !hardest) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300">
        <CheckCircle2Icon className="size-4 shrink-0" />
        <span>Cả lớp đang theo kịp tốt — không có học viên hay câu hỏi nào đáng lo.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-sm dark:border-amber-800/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangleIcon className="size-4 shrink-0" />
        Cần chú ý
      </div>
      <ul className="ml-6 list-disc text-amber-900/90 dark:text-amber-200/90">
        {atRisk.length > 0 && (
          <li>
            <span className="font-semibold">{atRisk.length}</span> học viên có mức tương tác thấp
            (&lt; {ENGAGEMENT_WARN}): {atRisk.slice(0, 3).map((a) => a.displayName).join(", ")}
            {atRisk.length > 3 ? `, +${atRisk.length - 3} nữa` : ""}.
          </li>
        )}
        {hardest && (
          <li>
            Câu khó nhất: <span className="font-medium">“{hardest.prompt}”</span> — chỉ{" "}
            <span className="font-semibold">{Math.round(hardest.accuracy * 100)}%</span> trả lời đúng.
          </li>
        )}
      </ul>
    </div>
  );
}

/** A per-kind accuracy pill strip, styled like exercise-overview's KIND_BADGES. */
function KindAccuracyStrip({ perKind }: { perKind: KindAccuracy[] }) {
  // Sort weakest-first so the skill the class most needs re-teaching is on top,
  // and use score-tier colours so low accuracy reads red at a glance.
  const shown = perKind
    .filter((k) => k.responseCount > 0)
    .sort((a, b) => a.accuracy - b.accuracy);
  // A "by-type comparison" needs ≥2 types — a single lone bar is content-free
  // (the overall score + per-question cards already convey it). Matches the
  // student-side gate in lesson-result.tsx.
  if (shown.length < 2) return null;
  return (
    <div className="rounded-md border bg-card p-4" data-testid="kind-accuracy-strip">
      <h3 className="mb-2 inline-flex items-center gap-1 text-sm font-medium">
        Độ chính xác theo loại câu hỏi
        <InfoHint text="Tỉ lệ trả lời đúng theo từng loại câu hỏi, xếp loại yếu nhất lên đầu để biết kỹ năng nào cần dạy lại." />
      </h3>
      <div className="flex flex-col gap-2">
        {shown.map((k) => (
          <ScoreBar
            key={k.kind}
            label={kindLabel(k.kind).label}
            frac={k.accuracy}
            right={`${Math.round(k.accuracy * 100)}% · ${k.responseCount}`}
            labelClass="w-32"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Per-question analysis for EVERY answered question (all kinds, not just
 * single-choice MCQ). Single-choice questions show the per-option answer
 * distribution; the other kinds (multiple choice, fill, reading, listening) show
 * the prompt + correct % + response count.
 */
function QuestionAnalysisPanel({ questions }: { questions: QuestionStat[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="question-analysis">
      <h3 className="text-sm font-medium">Phân tích câu hỏi</h3>
      <div className={`grid gap-3${questions.length > 1 ? " sm:grid-cols-2" : ""}`}>
        {questions.map((q) => {
          const totalChosen = q.options.reduce((acc, o) => acc + o.chosenCount, 0);
          const { label: kindText, color: kindColor } = kindLabel(q.kind);
          return (
            <div key={q.interactionId} className="rounded-md border bg-background p-3" data-testid="question-analysis-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className={`mb-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${kindColor}`}>
                    {kindText}
                  </span>
                  <p className="text-sm font-medium leading-snug">{q.prompt}</p>
                </div>
                <span
                  className={`shrink-0 font-mono text-xs font-semibold ${ratioColor(q.accuracy)}`}
                >
                  {Math.round(q.accuracy * 100)}%
                </span>
              </div>
              {q.options.length === 0 ? (
                // The accuracy % is already shown in the top-right ratio; here we
                // add only the response count so the number isn't printed twice.
                <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                  {q.responseCount} lượt trả lời
                </p>
              ) : (
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
              )}
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
      <NeedsAttentionBand attempts={attempts} questions={questions ?? []} />

      {perKind && perKind.length > 0 && <KindAccuracyStrip perKind={perKind} />}

      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{total} lượt nộp</p>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Học viên</TableHead>
                <TableHead className="text-center">
                  <span className="inline-flex items-center gap-1">
                    Số lần nộp
                    <InfoHint text="Số lượt học viên đã nộp bài (trên giới hạn lượt nộp của bài học, nếu có)." />
                  </span>
                </TableHead>
                <TableHead className="text-right">
                  <span className="inline-flex items-center gap-1">
                    Điểm
                    <InfoHint text="Điểm đạt được trên tổng điểm của bài (lượt nộp gần nhất)." />
                  </span>
                </TableHead>
                <TableHead className="hidden text-right xl:table-cell">
                  <span className="inline-flex items-center gap-1">
                    TG/câu
                    <InfoHint text="Thời gian trả lời trung bình cho mỗi câu hỏi." />
                  </span>
                </TableHead>
                <TableHead className="hidden text-right lg:table-cell">
                  <span className="inline-flex items-center gap-1">
                    Tổng TG
                    <InfoHint text="Tổng thời gian trả lời các câu hỏi (không tính thời gian xem video)." />
                  </span>
                </TableHead>
                <TableHead className="hidden text-right xl:table-cell">
                  <span className="inline-flex items-center gap-1">
                    Nghe lại
                    <InfoHint text="Số lần nghe lại trung bình ở các câu hỏi nghe (listening)." />
                  </span>
                </TableHead>
                <TableHead className="hidden text-right lg:table-cell">
                  <span className="inline-flex items-center gap-1">
                    % xem
                    <InfoHint text="Tỉ lệ thời lượng video học viên đã xem." />
                  </span>
                </TableHead>
                <TableHead className="text-right">
                  <span className="inline-flex items-center gap-1">
                    Tương tác
                    <InfoHint text="Điểm tương tác tổng hợp 0–100: 50% mức xem video + 50% điểm bài làm. Xanh ≥ 70, vàng 40–69, đỏ < 40." />
                  </span>
                </TableHead>
                <TableHead className="text-right">Nộp lúc</TableHead>
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
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{a.displayName}</span>
                        {a.email && <span className="text-xs text-muted-foreground">{a.email}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-center text-muted-foreground font-mono text-xs">
                      {a.attemptCount}{maxAttempts && maxAttempts > 0 ? ` / ${maxAttempts}` : ""}
                    </TableCell>
                    <TableCell className={`text-right font-medium font-mono ${scoreColor(a.totalScore, a.maxScore)}`}>
                      {formatScore(a.totalScore)}/{formatScore(a.maxScore)}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground text-xs font-mono xl:table-cell">
                      {formatAvgTimeMs(a.avgTimeToAnswerMs)}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground text-xs font-mono lg:table-cell">
                      {formatTimeOnTaskMs(a.timeOnTaskMs)}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground text-xs font-mono xl:table-cell">
                      {a.avgReplayCount.toFixed(1)}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground text-xs font-mono lg:table-cell">
                      {formatWatchFraction(a.videoWatchFraction)}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Every row is a submitted attempt, so an engagement of 0
                          is a real "fully disengaged" signal, not missing data —
                          show the red badge rather than hiding it behind a dash. */}
                      <Badge
                        variant="outline"
                        className={`font-mono text-xs px-1.5 py-0 ${badge.className}`}
                      >
                        {badge.label}
                      </Badge>
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
