"use client";

import { useMemo, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { VideoPlayer } from "./video-player";
import { QuizForm, type SafeQuestion } from "./quiz-form";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import type { QuizAttempt } from "buf/gen/richter/v1/quiz_pb";
import type { CheckpointQuestion } from "./quiz-checkpoint";

interface Props {
  // VideoPlayer
  videoUrl: string;
  segments: TranscriptSegment[];
  transcript: string;
  checkpoints: CheckpointQuestion[];
  lessonId: string;
  initialPosition: number;
  token: string;

  // QuizForm
  questions: SafeQuestion[];
  previousAttempt: QuizAttempt | null;
  initialCorrectAnswers?: number[];
  isPreview: boolean;
}

// StudentLessonView wraps VideoPlayer + QuizForm in the student flow so the
// two share a "revealed question" set. Without this wrapper the QuizForm
// below the video would spoil every question's text before the student
// actually reached its mark on the timeline.
export function StudentLessonView({
  videoUrl, segments, transcript, checkpoints, lessonId, initialPosition, token,
  questions, previousAttempt, initialCorrectAnswers, isPreview,
}: Props) {
  // Initial reveal:
  // - Already submitted (previousAttempt) → reveal everything for review.
  // - Otherwise EMPTY. Saved watch progress only seeks the video; it does NOT
  //   pre-unlock questions. Student must reach each mark in this session:
  //     • start_seconds > 0  → via checkpoint Continue (handleCheckpointPassed)
  //     • start_seconds ≤ 0  → via first Play (handleFirstPlay), since there
  //                            is no checkpoint mark to "reach" for these.
  const initialRevealed = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    if (previousAttempt) for (const q of questions) s.add(q.id);
    return s;
  }, [questions, previousAttempt]);

  const [revealedIds, setRevealedIds] = useState<Set<string>>(initialRevealed);

  function handleCheckpointPassed(id: string) {
    setRevealedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function handleFirstPlay() {
    setRevealedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const q of questions) {
        if (q.startSeconds <= 0 && !next.has(q.id)) {
          next.add(q.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  const hasQuestions = questions.length > 0;
  // Teachers in preview mode see everything (no progressive reveal).
  const visibleIds = isPreview ? undefined : revealedIds;

  return (
    <>
      <VideoPlayer
        videoUrl={videoUrl}
        segments={segments}
        transcript={transcript}
        checkpoints={checkpoints}
        lessonId={lessonId}
        initialPosition={initialPosition}
        token={token}
        onCheckpointPassed={handleCheckpointPassed}
        onFirstPlay={handleFirstPlay}
      />

      {hasQuestions && (
        <div className="rounded-lg border p-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">
              Câu hỏi trắc nghiệm ({questions.length} câu)
            </h2>
          </div>
          <QuizForm
            questions={questions}
            previousAttempt={isPreview ? null : previousAttempt}
            initialCorrectAnswers={initialCorrectAnswers}
            lessonId={lessonId}
            isPreview={isPreview}
            token={token}
            visibleQuestionIds={visibleIds}
          />
        </div>
      )}
    </>
  );
}
