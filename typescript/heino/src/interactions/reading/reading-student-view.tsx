"use client";

import ReactMarkdown from "react-markdown";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import type { StudentViewProps, ReadingConfig, ReadingResponse } from "../types";
import { AudioRecorder } from "../_shared/audio-recorder";
import { Button } from "@/components/ui/button";

export function ReadingStudentView({
  config,
  feedbackMode,
  locked,
  initialResponse,
  onAnswer,
  onContinue,
  token = "",
  lessonId = "",
}: StudentViewProps<ReadingConfig, ReadingResponse>) {
  const hasRecording = !!initialResponse?.audioObjectKey;

  function handleRecordingComplete(audioObjectKey: string) {
    onAnswer({ audioObjectKey });
  }

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
          initialAudioKey={initialResponse?.audioObjectKey}
          onComplete={handleRecordingComplete}
        />
      ) : (
        <p className="text-xs text-muted-foreground italic">Chế độ xem trước — ghi âm không khả dụng.</p>
      )}

      {/* Continue button */}
      {hasRecording && (
        <Button size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          {feedbackMode === FeedbackMode.AFTER_EACH ? "▶ Xem kết quả" : "▶ Tiếp tục xem"}
        </Button>
      )}
    </div>
  );
}
