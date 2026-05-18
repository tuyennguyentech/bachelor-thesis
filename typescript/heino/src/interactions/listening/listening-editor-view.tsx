"use client";

import { useState } from "react";
import { UploadCloudIcon, PlusIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import type { EditorViewProps, ListeningConfig, McqConfig } from "../types";
import { NestedMcqEditor } from "../_shared/nested-mcq";

const AUDIO_CONTENT_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
  "audio/aac",
]);

const EMPTY_MCQ: McqConfig = {
  options: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
  correctAnswer: 0,
};

export function ListeningEditorView({ config, onChange, lessonId = "", token = "" }: EditorViewProps<ListeningConfig>) {
  const storageClient = useRichterWebClient(StorageService, token);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleAudioFile(file: File) {
    const ct = file.type || "audio/mpeg";
    if (!AUDIO_CONTENT_TYPES.has(ct) && !ct.startsWith("audio/")) {
      setUploadError("Chỉ hỗ trợ tệp audio (mp3, wav, ogg, m4a…).");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const ext = file.name.split(".").pop() ?? "mp3";
      const key = `lessons/${lessonId}/audio-${Date.now()}.${ext}`;
      const { uploadUrl } = await storageClient.getUploadUrl({ key, contentType: ct, expiresInSeconds: 3600 });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("load", () => xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
        xhr.addEventListener("error", () => reject(new Error("Lỗi mạng")));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", ct);
        xhr.send(file);
      });

      let duration = 0;
      try {
        duration = await new Promise<number>((resolve) => {
          const audio = document.createElement("audio");
          const url = URL.createObjectURL(file);
          const cleanup = () => URL.revokeObjectURL(url);
          const t = setTimeout(() => { cleanup(); resolve(0); }, 8000);
          audio.addEventListener("loadedmetadata", () => { clearTimeout(t); cleanup(); resolve(isFinite(audio.duration) ? Math.round(audio.duration) : 0); });
          audio.addEventListener("error", () => { clearTimeout(t); cleanup(); resolve(0); });
          audio.src = url;
        });
      } catch { duration = 0; }

      onChange({ ...config, audioObjectKey: key, durationSeconds: duration });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setUploading(false);
    }
  }

  function addQuestion() {
    onChange({ ...config, comprehensionQuestions: [...config.comprehensionQuestions, { ...EMPTY_MCQ, options: EMPTY_MCQ.options.map((o) => ({ ...o })) }] });
  }

  function updateQuestion(qi: number, q: McqConfig) {
    onChange({ ...config, comprehensionQuestions: config.comprehensionQuestions.map((c, i) => (i === qi ? q : c)) });
  }

  function removeQuestion(qi: number) {
    onChange({ ...config, comprehensionQuestions: config.comprehensionQuestions.filter((_, i) => i !== qi) });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Audio upload */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">File audio</label>
        <div className="flex items-center gap-2">
          <label className={`inline-flex items-center gap-1.5 text-sm cursor-pointer rounded border border-input px-3 py-1.5 hover:bg-muted/50 transition-colors ${uploading ? "opacity-60 pointer-events-none" : ""}`}>
            {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <UploadCloudIcon className="size-3.5" />}
            {uploading ? "Đang tải…" : config.audioObjectKey ? "Thay audio" : "Tải audio lên"}
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAudioFile(f); e.target.value = ""; }} />
          </label>
          {config.audioObjectKey && <span className="text-xs text-muted-foreground truncate max-w-[160px]">{config.audioObjectKey.split("/").pop()}</span>}
        </div>
        {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
      </div>

      {/* Mode select */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Dạng bài</label>
        <div className="flex gap-2">
          {(["dictation", "comprehension"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChange({ ...config, mode: m })}
              className={`text-sm px-3 py-1.5 rounded border transition-colors ${config.mode === m ? "border-primary bg-primary/10 text-primary font-medium" : "border-input hover:border-primary/50"}`}
            >
              {m === "dictation" ? "Nghe chép" : "Nghe hiểu"}
            </button>
          ))}
        </div>
      </div>

      {/* Dictation: expected text */}
      {config.mode === "dictation" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Đáp án mẫu (nội dung nghe được)</label>
          <textarea
            rows={3}
            value={config.expectedText}
            onChange={(e) => onChange({ ...config, expectedText: e.target.value })}
            placeholder="Nhập nội dung đúng mà học sinh cần nghe…"
            className="text-sm rounded border border-input bg-background px-2 py-1.5 resize-none"
          />
        </div>
      )}

      {/* Comprehension: MCQ list */}
      {config.mode === "comprehension" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">Câu hỏi ({config.comprehensionQuestions.length})</label>
          {config.comprehensionQuestions.map((q, qi) => (
            <NestedMcqEditor
              key={qi}
              questionIndex={qi}
              config={q}
              onChange={(updated) => updateQuestion(qi, updated)}
              onRemove={() => removeQuestion(qi)}
            />
          ))}
          <Button type="button" variant="outline" size="sm" className="gap-1.5 self-start" onClick={addQuestion}>
            <PlusIcon className="size-3.5" /> Thêm câu hỏi
          </Button>
        </div>
      )}
    </div>
  );
}
