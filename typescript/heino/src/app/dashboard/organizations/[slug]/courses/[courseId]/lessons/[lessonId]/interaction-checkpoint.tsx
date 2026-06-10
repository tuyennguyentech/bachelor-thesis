"use client";

import { BookOpenIcon, CheckSquareIcon, ClockIcon, HeadphonesIcon, PencilLineIcon } from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { getRenderer, extractConfig } from "@/interactions/registry";
import type { InteractionGrade } from "@/interactions/types";
import { cn } from "@/lib/utils";

interface Props {
  interaction: LessonInteraction;
  index: number;
  total: number;
  feedbackMode: FeedbackMode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialResponse: any | null;
  locked: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAnswer: (response: any) => void;
  onContinue: () => void;
  hasNextInCheckpoint?: boolean;
  token?: string;
  lessonId?: string;
  isPreview?: boolean;
  onGrade?: (grade: InteractionGrade) => void;
  onReplayCount?: (count: number) => void;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const KIND_META: Partial<Record<InteractionKind, {
  description: string;
  icon: typeof CheckSquareIcon;
  shellClass: string;
  badgeClass: string;
}>> = {
  [InteractionKind.SINGLE_CHOICE]: {
    description: "Chọn một đáp án đúng",
    icon: CheckSquareIcon,
    shellClass: "border-l-rose-400",
    badgeClass: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  },
  [InteractionKind.MULTIPLE_CHOICE]: {
    description: "Chọn một hoặc nhiều đáp án đúng",
    icon: CheckSquareIcon,
    shellClass: "border-l-purple-400",
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300",
  },
  [InteractionKind.FILL_BLANK]: {
    description: "Điền đủ các chỗ trống",
    icon: PencilLineIcon,
    shellClass: "border-l-emerald-400",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  [InteractionKind.READING]: {
    description: "Đọc hoặc trả lời bằng ghi âm",
    icon: BookOpenIcon,
    shellClass: "border-l-sky-400",
    badgeClass: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  },
  [InteractionKind.LISTENING]: {
    description: "Nghe tệp rồi trả lời",
    icon: HeadphonesIcon,
    shellClass: "border-l-amber-400",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  },
};

export function InteractionCheckpoint({
  interaction,
  index,
  total,
  feedbackMode,
  initialResponse,
  locked,
  onAnswer,
  onContinue,
  hasNextInCheckpoint,
  token,
  lessonId,
  isPreview,
  onGrade,
  onReplayCount,
}: Props) {
  let renderer;
  try {
    renderer = getRenderer(interaction.kind);
  } catch {
    return (
      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        Loại câu hỏi chưa được hỗ trợ.
      </div>
    );
  }

  const config = extractConfig(interaction);

  if (!config) {
    return (
      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        Loại câu hỏi chưa được hỗ trợ.
      </div>
    );
  }

  const kindMeta = KIND_META[interaction.kind];
  const KindIcon = kindMeta?.icon ?? CheckSquareIcon;

  return (
    <div
      data-testid="quiz-checkpoint"
      className={cn(
        "rounded-md border border-l-4 bg-muted/40 p-4 flex flex-col gap-4",
        kindMeta?.shellClass ?? "border-l-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold",
              kindMeta?.badgeClass ?? "bg-muted text-muted-foreground",
            )}
          >
            <KindIcon className="size-3.5" />
            {renderer.label}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{kindMeta?.description ?? "Hoàn thành câu hỏi"}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Làm xong câu này để tiếp tục video.</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium flex items-center gap-1">
            <ClockIcon className="size-3" />
            {formatTime(interaction.startSeconds)}
          </span>
          <span>Câu {index}/{total}</span>
        </div>
      </div>

      <p className="text-sm font-medium">{interaction.prompt}</p>

      <renderer.StudentView
        config={config}
        explanation={interaction.explanation}
        initialResponse={initialResponse}
        feedbackMode={feedbackMode}
        locked={locked}
        onAnswer={onAnswer}
        onContinue={onContinue}
        hasNextInCheckpoint={hasNextInCheckpoint}
        token={token}
        lessonId={lessonId}
        interactionId={interaction.id}
        isPreview={isPreview}
        kind={interaction.kind}
        onGrade={onGrade}
        onReplayCount={onReplayCount}
      />
    </div>
  );
}
