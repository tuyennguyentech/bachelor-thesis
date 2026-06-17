"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  ClockIcon,
  HeadphonesIcon,
  ListChecksIcon,
  RotateCcwIcon,
  TargetIcon,
  VideoIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { getRenderer, extractConfig } from "@/interactions/registry";
import { formatScore } from "@/lib/format";
import { ScoreBar, scoreBarClass, scoreTextClass } from "@/components/score-viz";
import { kindMeta } from "@/interactions/kind-meta";

export interface QuizResult {
  totalScore: number;
  maxScore: number;
  attemptCount?: number;
  responses: {
    interactionId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any; // McqResponse | FillBlankResponse | null
    score: number;
    maxScore: number;
    feedback?: string;
  }[];
}

export interface PreviewMetrics {
  /** Per-interaction time-to-answer in ms, keyed by interaction id */
  timeToAnswerMs: Map<string, number>;
  /** Per-interaction replay counts (listening only), keyed by interaction id */
  replayCounts: Map<string, number>;
  /** Fraction (0–1) of the video watched */
  videoWatchFraction: number;
}

interface Props {
  result: QuizResult;
  interactions: LessonInteraction[];
  feedbackMode: FeedbackMode;
  onRetake: () => void;
  token?: string;
  maxAttempts?: number;
  /** Present only in preview mode — shows teacher-facing reference metrics */
  previewMetrics?: PreviewMetrics;
  /** Href to the next lesson, if any. When set, the result header shows a "Bài tiếp theo →" CTA. */
  nextLessonHref?: string;
  /** Href back to the course overview page. */
  courseHref?: string;
}

/** Count a value up from 0 to `target` with an easeOutCubic curve on mount, so
 *  the score reveal feels earned rather than appearing instantly. */
function useCountUp(target: number, durationMs = 900): number {
  const [val, setVal] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(target * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);
  return val;
}

/** Tiny celebratory emoji that float up and fade — only rendered on a high score. */
const CELEBRATE_EMOJI = ["🎉", "✨", "🌟", "🎊", "⭐"];

function DonutScore({
  score,
  total,
  attemptCount,
  maxAttempts,
  correctCount,
  totalQuestions,
  showCounts,
}: {
  score: number;
  total: number;
  attemptCount?: number;
  maxAttempts?: number;
  correctCount: number;
  totalQuestions: number;
  showCounts: boolean;
}) {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const animPct = useCountUp(pct);
  const r = 52;
  const circ = 2 * Math.PI * r;
  const filled = (animPct / 100) * circ;
  const color = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
  const celebrate = pct >= 80;
  const headline = pct >= 80 ? "Xuất sắc! 🎉" : pct >= 50 ? "Làm tốt lắm! 👍" : "Đừng nản — làm lại nhé! 💪";

  return (
    <div className="flex items-center gap-3">
      <style>{`
        @keyframes dyadia-float-up {
          0%   { transform: translate(-50%, 6px) scale(0.5); opacity: 0; }
          20%  { opacity: 1; }
          100% { transform: translate(-50%, -52px) scale(1.15); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dyadia-celebrate-emoji { display: none; }
        }
      `}</style>
      <div className="relative">
        {celebrate && (
          <div className="pointer-events-none absolute inset-0 z-10" aria-hidden>
            {CELEBRATE_EMOJI.map((e, i) => (
              <span
                key={i}
                className="dyadia-celebrate-emoji absolute left-1/2 top-2 text-lg"
                style={{
                  left: `${24 + i * 20}%`,
                  animation: `dyadia-float-up 1.6s ease-out ${i * 0.18}s infinite`,
                }}
              >
                {e}
              </span>
            ))}
          </div>
        )}
        <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label={`Điểm: ${pct}%`}>
          <title>{`Điểm: ${pct}%`}</title>
          <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/40" />
          <circle
            cx="64" cy="64" r={r} fill="none"
            stroke={color} strokeWidth="8"
            strokeDasharray={`${filled} ${circ - filled}`}
            strokeLinecap="round"
            transform="rotate(-90 64 64)"
            style={celebrate ? { filter: "drop-shadow(0 0 5px rgba(34,197,94,0.55))" } : undefined}
          />
          <text x="64" y="72" textAnchor="middle" fontSize="22" fontWeight="700" fill="currentColor" className="text-foreground">
            {`${Math.round(animPct)}%`}
          </text>
        </svg>
      </div>
      <div className="flex flex-col text-left">
        <span className="text-sm font-semibold">{formatScore(score)}/{formatScore(total)} điểm</span>
        <span className="text-xs text-muted-foreground flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{headline}</span>
          {showCounts && totalQuestions > 0 && (
            <span className="font-medium">Bạn đúng {correctCount}/{totalQuestions} câu</span>
          )}
          {maxAttempts !== undefined && maxAttempts > 0 && (
            <span className="text-[10px] text-muted-foreground font-semibold">
              Số lượt đã nộp: {attemptCount ?? 0}/{maxAttempts}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function PreviewMetricsPanel({ metrics, interactions }: { metrics: PreviewMetrics; interactions: LessonInteraction[] }) {
  const pct = Math.round(metrics.videoWatchFraction * 100);
  return (
    <div className="rounded-md border border-dashed border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/20 p-4 flex flex-col gap-3">
      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
        Chỉ số tham khảo (chế độ xem thử)
      </p>

      {/* Video watch fraction */}
      <div className="flex items-center gap-2 text-sm">
        <VideoIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Xem video:</span>
        <span className="font-medium">{pct}%</span>
      </div>

      {/* Per-interaction metrics */}
      <div className="flex flex-col gap-1.5">
        {interactions.map((it, idx) => {
          const ttaMs = metrics.timeToAnswerMs.get(it.id) ?? 0;
          const replays = metrics.replayCounts.get(it.id);
          return (
            <div key={it.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
              <span className="text-muted-foreground w-14 shrink-0">Câu {idx + 1}</span>
              <span className="flex items-center gap-1">
                <ClockIcon className="size-3 text-muted-foreground" />
                <span className="text-muted-foreground">Thời gian:</span>
                <span className="font-medium tabular-nums">{formatMs(ttaMs)}</span>
              </span>
              {replays !== undefined && (
                <span className="flex items-center gap-1">
                  <HeadphonesIcon className="size-3 text-muted-foreground" />
                  <span className="text-muted-foreground">Nghe lại:</span>
                  <span className="font-medium tabular-nums">{replays} lần</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LessonResult({ result, interactions, feedbackMode, onRetake, token, maxAttempts, previewMetrics, nextLessonHref, courseHref }: Props) {
  const canRetake = !maxAttempts || maxAttempts <= 0 || (result.attemptCount ?? 0) < maxAttempts;
  const shouldShowDetails = feedbackMode !== FeedbackMode.HIDDEN;
  const [onlyWrong, setOnlyWrong] = useState(false);

  const pct = result.maxScore > 0 ? Math.round((result.totalScore / result.maxScore) * 100) : 0;

  // Per-question cells (for the result strip) + per-skill aggregation (for the
  // kind breakdown). Both derive from `result.responses` joined to `interactions`.
  // A response whose interaction was regenerated after submit no longer matches
  // any `interactions` row — we drop it here, mirroring the backend's `continue`,
  // so the per-question view stays internally consistent.
  const cells = interactions.map((it, idx) => {
    const resp = result.responses.find((r) => r.interactionId === it.id);
    const score = resp?.score ?? 0;
    const max = resp?.maxScore ?? it.maxScore;
    const frac = max > 0 ? score / max : 0;
    return {
      n: idx + 1,
      id: it.id,
      frac,
      isWrong: frac < 0.999,
      title: `Câu ${idx + 1} · ${formatScore(score)}/${formatScore(max)} điểm`,
    };
  });
  const totalQuestions = cells.length;
  const correctCount = cells.filter((c) => !c.isWrong).length;
  const wrongCount = totalQuestions - correctCount;

  const byKind = new Map<InteractionKind, { score: number; max: number; count: number }>();
  for (const it of interactions) {
    const resp = result.responses.find((r) => r.interactionId === it.id);
    const max = resp?.maxScore ?? it.maxScore;
    if (max <= 0) continue;
    const cur = byKind.get(it.kind) ?? { score: 0, max: 0, count: 0 };
    cur.score += resp?.score ?? 0;
    cur.max += max;
    cur.count += 1;
    byKind.set(it.kind, cur);
  }
  const skillRows = [...byKind.entries()]
    .map(([kind, v]) => ({ kind, frac: v.max > 0 ? v.score / v.max : 0, count: v.count }))
    .sort((a, b) => a.frac - b.frac); // weakest skill first
  const allMastered = skillRows.length > 0 && skillRows.every((s) => s.frac >= 0.8);
  const weakest = skillRows[0];

  // CTA priority adapts to the outcome: a struggling student who can retake is
  // nudged to try again first; everyone else is nudged forward to the next lesson.
  const retakeFirst = canRetake && pct < 50;

  function scrollToQuestion(id: string) {
    document.getElementById(`dyadia-q-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const nextCta = nextLessonHref ? (
    <Button asChild className="gap-1.5">
      <Link href={nextLessonHref}>
        {pct >= 80 ? "Tuyệt vời! Học tiếp" : "Bài tiếp theo"}
        <ArrowRightIcon className="size-4" />
      </Link>
    </Button>
  ) : courseHref ? (
    <Button asChild variant="secondary" className="gap-1.5">
      <Link href={courseHref}>Về trang khóa học</Link>
    </Button>
  ) : (
    <Button variant="secondary" className="gap-1.5">Về trang khóa học</Button>
  );
  const retakeCta = canRetake ? (
    retakeFirst ? (
      <Button className="gap-1.5 shrink-0" onClick={onRetake}>
        <RotateCcwIcon className="size-3.5" />
        Làm lại để cải thiện
      </Button>
    ) : (
      <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={onRetake}>
        <RotateCcwIcon className="size-3.5" />
        Làm lại
      </Button>
    )
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border bg-muted/30 p-4 flex flex-col items-center gap-4 text-center">
        <span className="self-start text-sm font-medium">🎯 Kết quả</span>
        <DonutScore
          score={result.totalScore}
          total={result.maxScore}
          attemptCount={result.attemptCount}
          maxAttempts={maxAttempts}
          correctCount={correctCount}
          totalQuestions={totalQuestions}
          showCounts={shouldShowDetails}
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* When retaking is the recommended action it leads; otherwise the
              forward nudge leads and retake is the secondary option. */}
          {retakeFirst ? (
            <>
              {retakeCta}
              {nextCta}
            </>
          ) : (
            <>
              {nextCta}
              {retakeCta}
            </>
          )}
        </div>
      </div>

      {previewMetrics && (
        <PreviewMetricsPanel metrics={previewMetrics} interactions={interactions} />
      )}

      {/* Question-by-question result strip — a glanceable map of where points were
          lost, mirroring the teacher heatmap at the personal level. Each cell jumps
          to its detailed review row below. */}
      {shouldShowDetails && cells.length > 0 && (
        <div className="rounded-md border bg-card p-4" data-testid="result-question-strip">
          <h3 className="mb-2 text-sm font-medium">Từng câu</h3>
          <div className="flex flex-wrap gap-1.5">
            {cells.map((c) => (
              <button
                key={c.n}
                type="button"
                title={`${c.title} · bấm để xem chi tiết`}
                onClick={() => scrollToQuestion(c.id)}
                className={`flex size-7 items-center justify-center rounded text-xs font-semibold text-white transition-transform hover:scale-110 hover:ring-2 hover:ring-offset-1 hover:ring-foreground/20 ${scoreBarClass(c.frac)}`}
              >
                {c.n}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Per-skill (interaction-kind) accuracy — tells the learner WHICH skill to
          practise, which the single overall score can't. Only when ≥2 kinds. */}
      {shouldShowDetails && skillRows.length > 1 && (
        <div className="rounded-md border bg-card p-4" data-testid="result-skill-breakdown">
          <h3 className="mb-2 text-sm font-medium">Theo kỹ năng</h3>
          <div className="flex flex-col gap-2">
            {skillRows.map((s) => (
              <ScoreBar
                key={s.kind}
                label={kindMeta(s.kind).label}
                frac={s.frac}
                right={`${Math.round(s.frac * 100)}%`}
              />
            ))}
          </div>
          {/* One actionable takeaway so the chart isn't left for the learner to decode. */}
          <p className="mt-3 flex items-center gap-1.5 text-xs">
            <TargetIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {allMastered ? (
              <span className="text-muted-foreground">Bạn nắm vững tất cả kỹ năng trong bài này 👏</span>
            ) : (
              <span className="text-muted-foreground">
                Nên luyện thêm:{" "}
                <span className={`font-semibold ${scoreTextClass(weakest.frac)}`}>
                  {kindMeta(weakest.kind).label} ({Math.round(weakest.frac * 100)}%)
                </span>
              </span>
            )}
          </p>
        </div>
      )}

      {shouldShowDetails && interactions.length > 0 && (
        <div className="flex flex-col gap-2">
          {/* "Chỉ xem câu sai" — students care most about mistakes; this removes
              the scroll-hunt through fully-correct rows. Shown only when relevant. */}
          {wrongCount > 0 && correctCount > 0 && (
            <div className="flex items-center justify-end">
              <Button
                variant={onlyWrong ? "default" : "outline"}
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setOnlyWrong((v) => !v)}
                data-testid="toggle-only-wrong"
              >
                <ListChecksIcon className="size-3.5" />
                {onlyWrong ? `Xem tất cả (${totalQuestions})` : `Chỉ xem câu sai (${wrongCount})`}
              </Button>
            </div>
          )}
          <div className="flex flex-col rounded-md border divide-y">
            {interactions.map((it, idx) => {
              const respItem = result.responses.find((r) => r.interactionId === it.id);
              const config = extractConfig(it);
              if (!config) return null;

              const max = respItem?.maxScore ?? it.maxScore;
              const isWrong = max > 0 ? (respItem?.score ?? 0) / max < 0.999 : false;
              if (onlyWrong && !isWrong) return null;

              let renderer;
              try {
                renderer = getRenderer(it.kind);
              } catch {
                return null;
              }

              return (
                <div key={it.id} id={`dyadia-q-${it.id}`} className="px-4 scroll-mt-20">
                  <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2">
                    <span className="text-xs font-medium text-muted-foreground">Câu {idx + 1}</span>
                    <span className="rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-semibold tabular-nums">
                      {formatScore(respItem?.score ?? 0)}/{formatScore(respItem?.maxScore ?? it.maxScore)} điểm
                    </span>
                  </div>
                  <renderer.ReviewRow
                    index={idx + 1}
                    prompt={it.prompt}
                    explanation={it.explanation}
                    config={config}
                    response={respItem?.response}
                    score={respItem?.score ?? 0}
                    feedback={respItem?.feedback}
                    feedbackMode={feedbackMode}
                    token={token}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
