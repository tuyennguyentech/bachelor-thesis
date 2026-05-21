"use client";

import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2Icon, MicIcon, SquareIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";

type RecorderState = "idle" | "requesting" | "recording" | "recorded" | "uploading" | "done" | "error";

interface Props {
  lessonId: string;
  token: string;
  disabled?: boolean;
  initialAudioKey?: string;
  onComplete: (audioObjectKey: string) => void;
}

export function AudioRecorder({ lessonId, token, disabled, initialAudioKey, onComplete }: Props) {
  const storageClient = useRichterWebClient(StorageService, token);

  const [state, setState] = useState<RecorderState>(initialAudioKey ? "done" : "idle");
  const [audioKey, setAudioKey] = useState<string>(initialAudioKey ?? "");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blobRef = useRef<Blob | null>(null);

  // Fetch download URL for existing/uploaded key for preview
  useEffect(() => {
    if (!audioKey) return;
    storageClient.getDownloadUrl({ key: audioKey, expiresInSeconds: 3600 })
      .then((res) => setPreviewUrl(res.downloadUrl))
      .catch(() => setPreviewUrl(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKey]);

  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  async function startRecording() {
    setState("requesting");
    setErrorMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : "";

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      blobRef.current = null;
      setDuration(0);

      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stopTimer();
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setState("recorded");
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };

      mr.start(200); // 200ms chunks
      setState("recording");
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (e) {
      setState("error");
      setErrorMsg(e instanceof Error ? e.message : "Không thể truy cập microphone");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    stopTimer();
  }

  async function upload() {
    if (!blobRef.current) return;
    setState("uploading");
    setErrorMsg("");
    try {
      const ext = blobRef.current.type.includes("ogg") ? "ogg" : "webm";
      const key = `lessons/${lessonId}/student-recordings/${crypto.randomUUID()}.${ext}`;
      const contentType = blobRef.current.type || "audio/webm";
      const { uploadUrl } = await storageClient.getUploadUrl({ key, contentType, expiresInSeconds: 300 });
      const res = await fetch(uploadUrl, {
        method: "PUT",
        body: blobRef.current,
        headers: { "Content-Type": contentType },
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      setAudioKey(key);
      setState("done");
      onComplete(key);
    } catch (e) {
      setState("error");
      setErrorMsg(e instanceof Error ? e.message : "Upload thất bại");
    }
  }

  function reset() {
    if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setAudioKey("");
    blobRef.current = null;
    setDuration(0);
    setErrorMsg("");
    setState("idle");
  }

  const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-2">
      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {state === "idle" && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={startRecording}
            className="gap-1.5"
          >
            <MicIcon className="size-3.5" /> Ghi âm
          </Button>
        )}

        {state === "requesting" && (
          <Button size="sm" variant="outline" disabled className="gap-1.5">
            <Loader2Icon className="size-3.5 animate-spin" /> Đang mở mic…
          </Button>
        )}

        {state === "recording" && (
          <Button
            size="sm"
            variant="destructive"
            onClick={stopRecording}
            className="gap-1.5"
          >
            <SquareIcon className="size-3.5" /> Dừng ({fmtDuration(duration)})
          </Button>
        )}

        {state === "recorded" && (
          <>
            <Button size="sm" onClick={upload} className="gap-1.5">
              <PlayIcon className="size-3.5" /> Nộp bản ghi âm
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} className="gap-1.5">
              <RefreshCwIcon className="size-3.5" /> Ghi lại
            </Button>
          </>
        )}

        {state === "uploading" && (
          <Button size="sm" disabled className="gap-1.5">
            <Loader2Icon className="size-3.5 animate-spin" /> Đang tải lên…
          </Button>
        )}

        {state === "done" && !disabled && (
          <Button size="sm" variant="ghost" onClick={reset} className="gap-1.5 text-xs">
            <RefreshCwIcon className="size-3.5" /> Ghi lại
          </Button>
        )}
      </div>

      {/* Preview player */}
      {previewUrl && (
        <audio
          src={previewUrl}
          controls
          className="w-full max-w-sm h-9"
          data-testid="recording-player"
        />
      )}

      {/* Status */}
      {state === "done" && audioKey && (
        <p className="text-xs text-green-600 dark:text-green-400">✓ Đã ghi âm thành công</p>
      )}
      {state === "error" && (
        <p className="text-xs text-destructive">{errorMsg || "Có lỗi xảy ra"}</p>
      )}
    </div>
  );
}
