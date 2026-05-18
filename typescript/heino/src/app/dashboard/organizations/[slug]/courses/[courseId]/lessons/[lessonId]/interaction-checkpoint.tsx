"use client";

import { ClockIcon } from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { getRenderer, extractConfig } from "@/interactions/registry";

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
  token?: string;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function InteractionCheckpoint({
  interaction,
  index,
  total,
  feedbackMode,
  initialResponse,
  locked,
  onAnswer,
  onContinue,
  token,
}: Props) {
  let renderer;
  try {
    renderer = getRenderer(interaction.kind);
  } catch {
    return (
      <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
        Loại câu hỏi chưa được hỗ trợ.
      </div>
    );
  }

  const config = extractConfig(interaction);

  if (!config) {
    return (
      <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
        Loại câu hỏi chưa được hỗ trợ.
      </div>
    );
  }

  return (
    <div
      data-testid="quiz-checkpoint"
      className="rounded-lg border bg-muted/40 p-4 flex flex-col gap-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          <ClockIcon className="size-3" />
          {formatTime(interaction.startSeconds)}
        </span>
        <span className="text-xs text-muted-foreground">
          Câu {index}/{total}
        </span>
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
        token={token}
      />
    </div>
  );
}
