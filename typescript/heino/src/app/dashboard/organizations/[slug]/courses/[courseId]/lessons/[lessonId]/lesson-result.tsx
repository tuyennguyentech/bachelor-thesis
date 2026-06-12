"use client";

import { ClockIcon, HeadphonesIcon, RotateCcwIcon, VideoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { getRenderer, extractConfig } from "@/interactions/registry";

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
}

function formatScore(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function DonutScore({ score, total, attemptCount, maxAttempts }: { score: number; total: number; attemptCount?: number; maxAttempts?: number }) {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const r = 26;
  const circ = 2 * Math.PI * r;
  const filled = (pct / 100) * circ;
  const color = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <div className="flex items-center gap-3">
      <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={`Điểm: ${pct}%`}>
        <title>Điểm: {pct}%</title>
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/40" />
        <circle
          cx="32" cy="32" r={r} fill="none"
          stroke={color} strokeWidth="6"
          strokeDasharray={`${filled} ${circ - filled}`}
          strokeLinecap="round"
          transform="rotate(-90 32 32)"
        />
        <text x="32" y="36" textAnchor="middle" fontSize="12" fontWeight="600" fill="currentColor" className="text-foreground">
          {pct}%
        </text>
      </svg>
      <div className="flex flex-col">
        <span className="text-sm font-semibold">{formatScore(score)}/{formatScore(total)} điểm</span>
        <span className="text-xs text-muted-foreground flex flex-col gap-0.5">
          <span>{pct >= 80 ? "Xuất sắc! 🎉" : pct >= 50 ? "Làm tốt lắm!" : "Cố gắng hơn nhé!"}</span>
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

export function LessonResult({ result, interactions, feedbackMode, onRetake, token, maxAttempts, previewMetrics }: Props) {
  const canRetake = !maxAttempts || maxAttempts <= 0 || (result.attemptCount ?? 0) < maxAttempts;
  const shouldShowDetails = feedbackMode !== FeedbackMode.HIDDEN;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border bg-muted/30 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">🎯 Kết quả</span>
          {canRetake ? (
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={onRetake}>
              <RotateCcwIcon className="size-3.5" />
              Làm lại
            </Button>
          ) : null}
        </div>
        <DonutScore score={result.totalScore} total={result.maxScore} attemptCount={result.attemptCount} maxAttempts={maxAttempts} />
      </div>

      {previewMetrics && (
        <PreviewMetricsPanel metrics={previewMetrics} interactions={interactions} />
      )}

      {shouldShowDetails && interactions.length > 0 && (
        <div className="flex flex-col rounded-md border divide-y">
          {interactions.map((it, idx) => {
            const respItem = result.responses.find((r) => r.interactionId === it.id);
            const config = extractConfig(it);
            if (!config) return null;

            let renderer;
            try {
              renderer = getRenderer(it.kind);
            } catch {
              return null;
            }

            return (
              <div key={it.id} className="px-4">
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
      )}
    </div>
  );
}
