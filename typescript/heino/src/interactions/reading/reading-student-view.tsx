"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Loader2Icon } from "lucide-react";
import { Code, ConnectError } from "@connectrpc/connect";
import { FeedbackMode, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import type { StudentViewProps, ReadingConfig, ReadingResponse } from "../types";
import { AudioRecorder } from "../_shared/audio-recorder";
import { Button } from "@/components/ui/button";

type GradeState =
  | { phase: "idle" }
  | { phase: "grading" }
  | { phase: "done"; score: number; maxScore: number; feedback: string }
  | { phase: "error"; message: string };

function previewGradeErrorMessage(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.Unavailable:
      case Code.DeadlineExceeded:
        return "Hệ thống AI tạm thời quá tải, hãy thử ghi âm lại.";
      case Code.FailedPrecondition:
        return "Chưa thể chấm điểm ngay — lớp học chưa bật chế độ phản hồi tức thì.";
      default:
        return "Chưa chấm được phần ghi âm này. Giáo viên sẽ xem lại khi bạn nộp bài.";
    }
  }
  return "Chưa chấm được phần ghi âm này. Giáo viên sẽ xem lại khi bạn nộp bài.";
}

export function ReadingStudentView({
  config,
  feedbackMode,
  locked,
  initialResponse,
  onAnswer,
  onContinue,
  hasNextInCheckpoint,
  token = "",
  lessonId = "",
  interactionId = "",
  isPreview = false,
}: StudentViewProps<ReadingConfig, ReadingResponse>) {
  const interactionClient = useRichterWebClient(InteractionService, token);
  const audioObjectKey = initialResponse?.audioObjectKey ?? "";
  const hasRecording = audioObjectKey !== "";
  const wantsInlineGrade =
    feedbackMode === FeedbackMode.AFTER_EACH && lessonId !== "" && interactionId !== "" && !isPreview;

  const [gradeState, setGradeState] = useState<GradeState>({ phase: "idle" });

  function handleRecordingComplete(key: string) {
    onAnswer({ audioObjectKey: key });
  }

  useEffect(() => {
    if (!wantsInlineGrade || !audioObjectKey) {
      setGradeState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setGradeState({ phase: "grading" });

    // Retry once on Code.Unavailable / DeadlineExceeded — these usually mean the
    // proxy briefly couldn't reach richter (dev rebuild) or Gemini was slow.
    // After the retry, surface the friendly error message.
    async function gradeWithRetry(attempt = 0): Promise<void> {
      try {
        const res = await interactionClient.previewGrade({
          lessonId,
          response: {
            interactionId,
            response: { case: "reading", value: { audioObjectKey } },
          },
        });
        if (cancelled) return;
        setGradeState({ phase: "done", score: res.score, maxScore: res.maxScore, feedback: res.feedback });
      } catch (err) {
        if (cancelled) return;
        const isTransient =
          err instanceof ConnectError &&
          (err.code === Code.Unavailable || err.code === Code.DeadlineExceeded);
        if (isTransient && attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000));
          if (cancelled) return;
          return gradeWithRetry(1);
        }
        setGradeState({ phase: "error", message: previewGradeErrorMessage(err) });
      }
    }
    void gradeWithRetry();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioObjectKey, wantsInlineGrade, lessonId, interactionId]);

  const canContinue =
    hasRecording && (!wantsInlineGrade || gradeState.phase === "done" || gradeState.phase === "error");

  return (
    <div className="flex flex-col gap-4">
      {/* Passage */}
      <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-muted/20 px-4 py-3 text-sm">
        <ReactMarkdown>{config.passageMarkdown}</ReactMarkdown>
      </div>

      {/* Question (open_answer only) */}
      {config.mode === "open_answer" && config.question && (
        <p className="text-sm font-medium">{config.question}</p>
      )}

      {/* Instructions */}
      <p className="text-xs text-muted-foreground">
        {config.mode === "open_answer"
          ? "Trả lời câu hỏi bằng lời nói, sau đó nộp bản ghi âm."
          : "Đọc to đoạn văn trên, sau đó nộp bản ghi âm để chấm điểm."}
      </p>

      {/* Audio recorder */}
      {lessonId ? (
        <AudioRecorder
          lessonId={lessonId}
          token={token}
          disabled={locked}
          initialAudioKey={audioObjectKey || undefined}
          onComplete={handleRecordingComplete}
        />
      ) : (
        <p className="text-xs text-muted-foreground italic">Chế độ xem trước — ghi âm không khả dụng.</p>
      )}

      {/* AFTER_EACH inline grade */}
      {wantsInlineGrade && gradeState.phase === "grading" && (
        <div data-testid="reading-grading" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> Đang chấm điểm…
        </div>
      )}
      {wantsInlineGrade && gradeState.phase === "done" && (
        <div data-testid="reading-grade-done" className="flex flex-col gap-2">
          <p className="text-xs">
            <span className="text-muted-foreground">Điểm: </span>
            <span data-testid="reading-grade-score" className="font-medium">
              {gradeState.maxScore > 0 ? Math.round((gradeState.score / gradeState.maxScore) * 100) : 0}%
            </span>
          </p>
          {gradeState.feedback && (
            <div className="rounded border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 px-3 py-2 flex gap-2">
              <span className="shrink-0 text-sm">💬</span>
              <p data-testid="reading-grade-feedback" className="text-xs text-blue-700 dark:text-blue-300 whitespace-pre-line">{gradeState.feedback}</p>
            </div>
          )}
          {config.mode === "open_answer" && config.expectedAnswer && (
            <p className="text-xs">
              <span className="text-muted-foreground">Đáp án mẫu: </span>
              <span>{config.expectedAnswer}</span>
            </p>
          )}
        </div>
      )}
      {wantsInlineGrade && gradeState.phase === "error" && (
        <p data-testid="reading-grade-error" className="text-xs text-destructive">⚠ {gradeState.message}</p>
      )}

      {/* Continue button */}
      {canContinue && (
        <Button size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          {hasNextInCheckpoint ? "Câu tiếp theo →" : "▶ Tiếp tục xem"}
        </Button>
      )}
    </div>
  );
}
