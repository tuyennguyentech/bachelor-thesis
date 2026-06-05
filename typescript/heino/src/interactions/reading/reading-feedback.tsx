"use client";

import { MessageSquareIcon, ScrollTextIcon } from "lucide-react";

interface ParsedReadingFeedback {
  transcript: string;
  feedback: string;
}

const SPOKEN_PREFIX = 'Bạn đã nói: "';
const SPOKEN_DELIMITER = '"\n\n';

export function parseReadingFeedback(value: string | undefined): ParsedReadingFeedback {
  const raw = value?.trim() ?? "";
  if (!raw) return { transcript: "", feedback: "" };
  if (!raw.startsWith(SPOKEN_PREFIX)) return { transcript: "", feedback: raw };

  const body = raw.slice(SPOKEN_PREFIX.length);
  const delimiterIndex = body.indexOf(SPOKEN_DELIMITER);
  if (delimiterIndex < 0) return { transcript: "", feedback: raw };

  return {
    transcript: body.slice(0, delimiterIndex).trim(),
    feedback: body.slice(delimiterIndex + SPOKEN_DELIMITER.length).trim(),
  };
}

export function ReadingFeedbackBlocks({
  feedback,
  transcriptTestId,
  feedbackTestId,
}: {
  feedback: string | undefined;
  transcriptTestId?: string;
  feedbackTestId?: string;
}) {
  const parsed = parseReadingFeedback(feedback);
  if (!parsed.transcript && !parsed.feedback) return null;

  return (
    <div className="flex flex-col gap-2">
      {parsed.transcript && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <ScrollTextIcon className="size-3.5" />
            Phiên âm câu trả lời
          </div>
          <p data-testid={transcriptTestId} className="whitespace-pre-line text-xs leading-relaxed text-emerald-800 dark:text-emerald-200">
            {parsed.transcript}
          </p>
        </div>
      )}
      {parsed.feedback && (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-950/30">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300">
            <MessageSquareIcon className="size-3.5" />
            Nhận xét
          </div>
          <p data-testid={feedbackTestId} className="whitespace-pre-line text-xs leading-relaxed text-blue-700 dark:text-blue-300">
            {parsed.feedback}
          </p>
        </div>
      )}
    </div>
  );
}
