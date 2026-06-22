"use client";

import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRightIcon, Loader2Icon, PlayIcon, Volume2Icon } from "lucide-react";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import type { StudentViewProps, ListeningConfig, ListeningResponse } from "../types";
import { NestedMcqStudent } from "../_shared/nested-mcq";

export function ListeningStudentView({
  config,
  feedbackMode,
  locked,
  initialResponse,
  onAnswer,
  hasNextInCheckpoint,
  onContinue,
  token = "",
  onReplayCount,
}: StudentViewProps<ListeningConfig, ListeningResponse>) {
  const storageClient = useRichterWebClient(StorageService, token);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playCountRef = useRef(0);

  const [answers, setAnswers] = useState<number[]>(
    initialResponse?.comprehensionAnswers ?? config.comprehensionQuestions.map(() => -1)
  );
  const audioReady = !!audioUrl;
  const hasAnswered = config.comprehensionQuestions.length > 0 && answers.every((a) => a >= 0);

  // Single MCQ where the audio IS the question (the stored question text is empty):
  // label the player "Nghe câu hỏi" and drop the per-question "Câu N" heading.
  const isAudioQuestion =
    config.comprehensionQuestions.length === 1 && !config.comprehensionQuestions[0]?.question?.trim();
  const audioLabel = isAudioQuestion ? "Nghe câu hỏi" : "Nghe tệp";

  useEffect(() => {
    if (!config.audioObjectKey) {
      setLoadingUrl(false);
      return;
    }
    storageClient.getDownloadUrl({ key: config.audioObjectKey, expiresInSeconds: 3600 })
      .then((res) => setAudioUrl(res.downloadUrl))
      .catch(() => setAudioUrl(null))
      .finally(() => setLoadingUrl(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.audioObjectKey]);

  function handleComprehensionSelect(qi: number, selected: number) {
    if (!audioReady || locked) return;
    const next = answers.map((a, i) => (i === qi ? selected : a));
    setAnswers(next);
    onAnswer({ comprehensionAnswers: next });
  }

  if (loadingUrl) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Đang tải tệp nghe…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Audio player */}
      {audioUrl ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Volume2Icon className="size-3.5" /> {audioLabel}
          </div>
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            className="w-full max-w-md h-10"
            data-testid="audio-player"
            onPlay={() => {
              playCountRef.current += 1;
              onReplayCount?.(playCountRef.current);
            }}
          />
        </div>
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          Không tải được tệp nghe. Vui lòng báo giáo viên tạo lại.
        </div>
      )}

      {config.comprehensionQuestions.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">Bài nghe chưa có câu hỏi.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {config.comprehensionQuestions.map((q, qi) => (
            <div key={qi} className="flex flex-col gap-2">
              {config.comprehensionQuestions.length > 1 && (
                <p className="text-sm font-medium">Câu {qi + 1}</p>
              )}
              <NestedMcqStudent
                questionIndex={qi}
                config={q}
                selected={answers[qi] ?? -1}
                locked={!audioReady || locked}
                revealAnswer={feedbackMode === FeedbackMode.AFTER_EACH && (answers[qi] ?? -1) >= 0}
                onSelect={(idx) => handleComprehensionSelect(qi, idx)}
              />
            </div>
          ))}
        </div>
      )}

      {audioReady && hasAnswered && (
        <Button size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          {hasNextInCheckpoint ? (
            <>
              Câu tiếp theo
              <ArrowRightIcon className="size-4" />
            </>
          ) : (
            <>
              <PlayIcon className="size-4" />
              Tiếp tục xem
            </>
          )}
        </Button>
      )}
    </div>
  );
}
