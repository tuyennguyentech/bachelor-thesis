"use client";

import { InfoIcon, PlayIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LessonInteraction, FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { LessonResult } from "./lesson-result";
import type { QuizResult } from "./lesson-result";

interface StudentLessonStatusCardProps {
  activeInteraction: LessonInteraction | null;
  error: string | null;
  feedbackMode: FeedbackMode;
  isPending: boolean;
  lessonInteractions: LessonInteraction[];
  maxAttempts?: number;
  onRetake: () => void;
  onSubmit: () => void;
  passedCount: number;
  readyToSubmit: boolean;
  result: QuizResult | null;
  submitted: boolean;
  token: string;
}

export function StudentLessonStatusCard({
  activeInteraction,
  error,
  feedbackMode,
  isPending,
  lessonInteractions,
  maxAttempts,
  onRetake,
  onSubmit,
  passedCount,
  readyToSubmit,
  result,
  submitted,
  token,
}: StudentLessonStatusCardProps) {
  if (
    lessonInteractions.length === 0 ||
    !((!submitted && !activeInteraction) || readyToSubmit || (submitted && result) || error)
  ) {
    return null;
  }

  const allAnswered = passedCount >= lessonInteractions.length;

  return (
    <div className="rounded-md border p-4 flex flex-col gap-3">
      {!submitted && !activeInteraction && passedCount === 0 && (
        <div className="rounded-md bg-muted/30 p-6 text-center">
          <InfoIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="mb-1 text-base font-medium">Bài học có {lessonInteractions.length} câu hỏi tương tác</p>
          <p className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            Video sẽ tạm dừng tại mỗi mốc để bạn trả lời. Bấm <PlayIcon className="size-3.5" /> để bắt đầu.
          </p>
        </div>
      )}

      {!submitted && !activeInteraction && passedCount > 0 && !allAnswered && (
        <p className="text-sm text-muted-foreground">
          Đã trả lời {passedCount}/{lessonInteractions.length} câu — tiếp tục xem video.
        </p>
      )}

      {readyToSubmit && !activeInteraction && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Đã trả lời đủ {lessonInteractions.length}/{lessonInteractions.length} câu. Sẵn sàng nộp bài!
          </p>
          <Button
            size="sm"
            className="self-start gap-2"
            disabled={isPending}
            onClick={onSubmit}
          >
            <SendIcon className="size-4" />
            {isPending ? "Đang nộp..." : "Nộp bài"}
          </Button>
        </div>
      )}

      {submitted && result && (
        <LessonResult
          result={result}
          interactions={lessonInteractions}
          feedbackMode={feedbackMode}
          onRetake={onRetake}
          token={token}
          maxAttempts={maxAttempts}
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
