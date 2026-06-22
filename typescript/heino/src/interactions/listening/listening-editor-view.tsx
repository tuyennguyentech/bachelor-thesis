"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2Icon, Loader2Icon, HeadphonesIcon, AlertCircleIcon } from "lucide-react";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import type { EditorViewProps, ListeningConfig, McqConfig } from "../types";
import { NestedMcqEditor } from "../_shared/nested-mcq";

const EMPTY_MCQ: McqConfig = {
  question: "",
  options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
  correctAnswer: 0,
};

export function ListeningEditorView({ config, onChange, lessonId = "", token = "" }: EditorViewProps<ListeningConfig>) {
  const aiClient = useRichterWebClient(AIService, token);
  const storageClient = useRichterWebClient(StorageService, token);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Autoplay the preview once the new <audio> is committed (runs after render, so
  // the ref exists even on the FIRST "Nghe thử" — a rAF would fire too early).
  useEffect(() => {
    if (previewUrl) audioRef.current?.play().catch(() => {});
  }, [previewUrl]);

  // A listening exercise is a single MCQ whose question is SPOKEN: the teacher edits
  // the question text and the audio is synthesised from it on save.
  const mcq = config.comprehensionQuestions[0] ?? EMPTY_MCQ;
  const setMcq = (updated: McqConfig) => onChange({ ...config, comprehensionQuestions: [updated] });

  async function handlePreview() {
    const text = config.audioSourceText?.trim();
    if (!text || !lessonId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const { audioObjectKey } = await aiClient.previewListeningAudio({ lessonId, text });
      const { downloadUrl } = await storageClient.getDownloadUrl({ key: audioObjectKey, expiresInSeconds: 3600 });
      setPreviewUrl(downloadUrl);
    } catch {
      setPreviewError("Không tạo được audio nghe thử. Vui lòng thử lại.");
    } finally {
      setPreviewLoading(false);
    }
  }

  const hasText = !!config.audioSourceText?.trim();

  return (
    <div className="flex flex-col gap-4">
      {/* ── Câu hỏi nói: edit text + audio synthesised from it ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <HeadphonesIcon className="size-3.5" />
          </span>
          <div className="flex flex-col">
            <label htmlFor="listening-question" className="text-sm font-medium leading-none">
              Câu hỏi (học viên sẽ nghe)
            </label>
            <span className="text-[11px] text-muted-foreground">
              Audio được tạo tự động từ đoạn chữ này khi lưu.
            </span>
          </div>
        </div>

        <textarea
          id="listening-question"
          rows={3}
          value={config.audioSourceText}
          onChange={(e) => { onChange({ ...config, audioSourceText: e.target.value }); setPreviewUrl(null); }}
          placeholder="Nhập câu hỏi. Học viên sẽ nghe câu hỏi này rồi chọn đáp án…"
          className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 leading-relaxed resize-y min-h-[4.5rem] focus:outline-none focus:ring-2 focus:ring-ring/50"
        />

        {/* Preview row: Nghe thử + an inline, full-width player once ready. */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handlePreview}
            disabled={!hasText || previewLoading}
            className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {previewLoading ? <Loader2Icon className="size-4 animate-spin" /> : <Volume2Icon className="size-4" />}
            {previewLoading ? "Đang tạo audio…" : previewUrl ? "Tạo lại audio" : "Nghe thử"}
          </button>

          {previewUrl && (
            <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-2">
              <Volume2Icon className="size-4 shrink-0 text-primary" />
              <audio
                ref={audioRef}
                src={previewUrl}
                controls
                className="h-9 w-full"
                data-testid="listening-preview-audio"
              />
            </div>
          )}

          {previewError && (
            <p className="flex items-center gap-1.5 text-[11px] text-destructive">
              <AlertCircleIcon className="size-3.5 shrink-0" />
              {previewError}
            </p>
          )}
          {!hasText && (
            <p className="text-[11px] text-muted-foreground">
              Nhập câu hỏi ở trên để bật nút nghe thử.
            </p>
          )}
        </div>
      </div>

      <NestedMcqEditor questionIndex={0} config={mcq} hideQuestion label="Các phương án trả lời" onChange={setMcq} />
    </div>
  );
}
