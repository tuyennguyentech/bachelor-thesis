"use client";

import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Loader2Icon, Volume2Icon } from "lucide-react";
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
  onContinue,
  hasNextInCheckpoint,
  token = "",
}: StudentViewProps<ListeningConfig, ListeningResponse>) {
  const storageClient = useRichterWebClient(StorageService, token);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Dictation state
  const [transcription, setTranscription] = useState(initialResponse?.transcription ?? "");
  const [dictationSubmitted, setDictationSubmitted] = useState(!!initialResponse?.transcription);

  // Comprehension state
  const [answers, setAnswers] = useState<number[]>(
    initialResponse?.comprehensionAnswers ?? config.comprehensionQuestions.map(() => -1)
  );
  const allComprehensionAnswered =
    config.mode === "comprehension" && answers.every((a) => a >= 0);
  const hasAnswered = config.mode === "dictation" ? dictationSubmitted : allComprehensionAnswered;

  useEffect(() => {
    if (!config.audioObjectKey) {
      console.warn("ListeningStudentView: config.audioObjectKey is empty or missing!");
      setLoadingUrl(false);
      return;
    }
    console.log("ListeningStudentView: fetching download URL for key:", config.audioObjectKey);
    storageClient.getDownloadUrl({ key: config.audioObjectKey, expiresInSeconds: 3600 })
      .then((res) => {
        console.log("ListeningStudentView: download URL fetched successfully:", res.downloadUrl);
        setAudioUrl(res.downloadUrl);
      })
      .catch((err) => {
        console.error("ListeningStudentView: failed to fetch download URL for key:", config.audioObjectKey, err);
        setAudioUrl(null);
      })
      .finally(() => setLoadingUrl(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.audioObjectKey]);

  function handleComprehensionSelect(qi: number, selected: number) {
    const next = answers.map((a, i) => (i === qi ? selected : a));
    setAnswers(next);
    onAnswer({ transcription: "", comprehensionAnswers: next });
  }

  function handleDictationSubmit() {
    if (!transcription.trim()) return;
    setDictationSubmitted(true);
    onAnswer({ transcription, comprehensionAnswers: [] });
  }

  if (loadingUrl) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Đang tải audio…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Audio player */}
      {audioUrl ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Volume2Icon className="size-3.5" /> Nghe audio
          </div>
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            className="w-full max-w-md h-10"
            data-testid="audio-player"
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">
          Audio chưa được tải lên. (Key: {config.audioObjectKey || "trống"})
        </p>
      )}

      {/* Dictation */}
      {config.mode === "dictation" && (
        <div className="flex flex-col gap-2">
          <label className="text-sm">Gõ lại những gì bạn nghe được:</label>
          <textarea
            rows={3}
            value={transcription}
            onChange={(e) => setTranscription(e.target.value)}
            disabled={locked || dictationSubmitted}
            placeholder="Nhập nội dung bạn nghe được…"
            className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none"
          />
          {!dictationSubmitted && (
            <Button
              size="sm"
              className="self-start"
              disabled={locked || !transcription.trim()}
              onClick={handleDictationSubmit}
            >
              Trả lời
            </Button>
          )}
          {dictationSubmitted && feedbackMode === FeedbackMode.AFTER_EACH && config.expectedText && (
            <div className="text-xs space-y-0.5">
              <p className="text-muted-foreground">Đáp án gợi ý:</p>
              <p className="font-medium">{config.expectedText}</p>
            </div>
          )}
          {dictationSubmitted && feedbackMode !== FeedbackMode.AFTER_EACH && (
            <p className="text-xs text-muted-foreground">✓ Đã ghi nhận</p>
          )}
        </div>
      )}

      {/* Comprehension */}
      {config.mode === "comprehension" && (
        <div className="flex flex-col gap-4">
          {config.comprehensionQuestions.map((q, qi) => (
            <div key={qi} className="flex flex-col gap-2">
              <p className="text-sm font-medium">Câu {qi + 1}</p>
              <NestedMcqStudent
                questionIndex={qi}
                config={q}
                selected={answers[qi] ?? -1}
                locked={locked}
                revealAnswer={feedbackMode === FeedbackMode.AFTER_EACH && (answers[qi] ?? -1) >= 0}
                onSelect={(idx) => handleComprehensionSelect(qi, idx)}
              />
            </div>
          ))}
        </div>
      )}

      {hasAnswered && (
        <Button size="sm" className="self-start gap-1.5" onClick={onContinue} disabled={locked}>
          {hasNextInCheckpoint ? "Câu tiếp theo →" : "▶ Tiếp tục xem"}
        </Button>
      )}
    </div>
  );
}
