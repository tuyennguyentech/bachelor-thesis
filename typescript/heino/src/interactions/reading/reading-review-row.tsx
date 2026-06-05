"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import type { ReviewRowProps, ReadingConfig, ReadingResponse } from "../types";
import { ReadingFeedbackBlocks } from "./reading-feedback";

export function ReadingReviewRow({
  index,
  prompt,
  config,
  response,
  score,
  feedback,
  feedbackMode,
  token = "",
}: ReviewRowProps<ReadingConfig, ReadingResponse>) {
  const storageClient = useRichterWebClient(StorageService, token);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const canReveal = feedbackMode !== FeedbackMode.HIDDEN;

  useEffect(() => {
    if (!response?.audioObjectKey) return;
    storageClient.getDownloadUrl({ key: response.audioObjectKey, expiresInSeconds: 3600 })
      .then((res) => setAudioUrl(res.downloadUrl))
      .catch(() => setAudioUrl(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response?.audioObjectKey]);

  return (
    <div className="flex flex-col gap-2 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={`shrink-0 size-5 rounded-full flex items-center justify-center text-xs font-medium border ${
            canReveal && score > 0
              ? "bg-green-100 border-green-500 text-green-700 dark:bg-green-950/30 dark:border-green-600 dark:text-green-400"
              : canReveal && response !== undefined
              ? "bg-red-100 border-red-400 text-red-600 dark:bg-red-950/30 dark:border-red-500 dark:text-red-400"
              : "bg-muted border-border text-muted-foreground"
          }`}
        >
          {index}
        </span>
        <div className="flex-1 flex flex-col gap-1">
          <p className="text-sm">{prompt}</p>
          <span className="text-xs text-muted-foreground">
            {config.mode === "open_answer" ? "💬 Trả lời câu hỏi" : "🗣 Đọc to"}
          </span>
        </div>
      </div>

      <div className="ml-7 flex flex-col gap-2">
        <div className="prose prose-sm dark:prose-invert max-w-none rounded border border-border bg-muted/10 px-3 py-2 text-xs">
          <ReactMarkdown>{config.passageMarkdown}</ReactMarkdown>
        </div>
        {config.mode === "open_answer" && config.question && (
          <p className="text-xs font-medium">{config.question}</p>
        )}
        {canReveal && config.mode === "open_answer" && config.expectedAnswer && (
          <p className="text-xs">
            <span className="text-muted-foreground">Đáp án mẫu: </span>
            <span>{config.expectedAnswer}</span>
          </p>
        )}
        {audioUrl ? (
          <audio src={audioUrl} controls className="w-full max-w-sm h-9" />
        ) : response?.audioObjectKey ? (
          <p className="text-xs text-muted-foreground italic">Đang tải bản ghi âm…</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">Chưa có bản ghi âm.</p>
        )}
        {canReveal && response?.audioObjectKey && (
          <p className="text-xs">
            <span className="text-muted-foreground">Điểm: </span>
            <span className="font-medium">{Math.round(score * 100)}%</span>
          </p>
        )}
        {canReveal && feedback && response?.audioObjectKey && (
          <ReadingFeedbackBlocks
            feedback={feedback}
            transcriptTestId="reading-review-transcript"
            feedbackTestId="reading-review-feedback"
          />
        )}
      </div>
    </div>
  );
}
