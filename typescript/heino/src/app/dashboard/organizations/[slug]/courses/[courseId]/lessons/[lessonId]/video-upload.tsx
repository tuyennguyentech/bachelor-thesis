"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { uploadConfig } from "@/lib/client-config";
import {
  UploadCloudIcon,
  CheckCircleIcon,
  Loader2Icon,
  FileVideo2Icon,
  AlertCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ALLOWED_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
]);

interface Props {
  lessonId: string;
  moduleId: string;
  courseId: string;
  slug: string;
  hasVideo: boolean;
  token: string;
}

export function VideoUpload({ lessonId, hasVideo, token }: Props) {
  const router = useRouter();
  const storageClient = useRichterWebClient(StorageService, token);
  const lessonClient = useRichterWebClient(LessonService, token);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      handleFile(file);
    }
  };

  async function handleFile(file: File) {
    setError(null);
    setDone(false);

    if (!file.type.startsWith("video/") || !ALLOWED_CONTENT_TYPES.has(file.type)) {
      setError("Chỉ hỗ trợ tệp video.");
      return;
    }

    setSelectedFile({
      name: file.name,
      size: (file.size / (1024 * 1024)).toFixed(2) + " MB",
    });
    setProgress(0);

    const ext = file.name.split(".").pop() ?? "mp4";
    const version = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `lessons/${lessonId}/video/${version}.${ext}`;

    let uploadUrl: string;
    try {
      const res = await storageClient.getUploadUrl({ key, contentType: file.type || "video/mp4", expiresInSeconds: 3600 });
      uploadUrl = res.uploadUrl;
    } catch {
      setError("Không lấy được đường dẫn tải lên. Kiểm tra kết nối lưu trữ.");
      setProgress(null);
      return;
    }

    let uploadOk = false;
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Tải video thất bại (HTTP ${xhr.status})`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Lỗi mạng khi tải lên")));
      xhr.addEventListener("timeout", () => reject(new Error("Tải video quá thời gian. Thử lại sau.")));
      xhr.timeout = 600_000;
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
      xhr.send(file);
    }).then(() => {
      uploadOk = true;
    }).catch((e: Error) => {
      setError(e.message);
      setProgress(null);
    });

    if (!uploadOk) return;

    let durationSeconds = 0;
    try {
      durationSeconds = await new Promise<number>((resolve) => {
        const video = document.createElement("video");
        const objectUrl = URL.createObjectURL(file);
        const cleanup = () => URL.revokeObjectURL(objectUrl);
        const timer = setTimeout(() => { cleanup(); resolve(0); }, uploadConfig.uploadTimeoutMs);
        video.addEventListener("loadedmetadata", () => {
          clearTimeout(timer);
          cleanup();
          resolve(isFinite(video.duration) ? Math.round(video.duration) : 0);
        });
        video.addEventListener("error", () => { clearTimeout(timer); cleanup(); resolve(0); });
        video.src = objectUrl;
      });
    } catch {
      durationSeconds = 0;
    }

    setIsPending(true);
    try {
      await lessonClient.updateLessonVideo({ id: lessonId, videoStorageKey: key, durationSeconds });
      setProgress(null);
      setDone(true);
      router.refresh();
    } catch {
      setError("Không thể cập nhật video bài học");
      setProgress(null);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />

      {progress !== null ? (
        <div className="rounded-md border bg-muted/10 p-4 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded bg-primary/10 p-2 text-primary">
              <FileVideo2Icon className="size-5 shrink-0" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{selectedFile?.name}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{selectedFile?.size}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Loader2Icon className="size-3 animate-spin text-primary" />
                Đang tải lên máy chủ...
              </span>
              <span className="font-semibold">{progress}%</span>
            </div>
            <div className="relative w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="absolute h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600 transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={() => !isPending && inputRef.current?.click()}
          className={cn(
            "relative group flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-lg cursor-pointer transition-all duration-300",
            isDragActive
              ? "border-primary bg-primary/5 shadow-md shadow-primary/10 scale-[1.01]"
              : "border-muted-foreground/20 bg-card/60 backdrop-blur-sm hover:border-primary/40 hover:bg-muted/10",
            isPending && "pointer-events-none opacity-60"
          )}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className={cn(
              "rounded-full p-3 transition-colors",
              isDragActive ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
            )}>
              <UploadCloudIcon className="size-6" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold text-foreground">
                {isDragActive ? "Thả tệp vào đây để tải lên" : (hasVideo || done) ? "Thay thế video bài học hiện tại" : "Kéo thả tệp video vào đây"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Hoặc nhấp chuột để chọn từ thiết bị
              </p>
            </div>
            <div className="mt-1">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-semibold shadow-sm hover:bg-accent hover:text-accent-foreground cursor-pointer focus:outline-none transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isPending) inputRef.current?.click();
                }}
              >
                <UploadCloudIcon className="size-3.5 mr-1 text-muted-foreground" />
                {(hasVideo || done) ? "Thay video" : "Tải video lên"}
              </button>
            </div>
            <p className="text-[9px] text-muted-foreground/80 max-w-[200px]">
              Định dạng MP4, WebM, MOV, MKV... tự động lấy độ dài
            </p>
          </div>
        </div>
      )}

      {done && !progress && (
        <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50/50 dark:bg-green-950/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">
          <CheckCircleIcon className="size-4 shrink-0" />
          <span>Video đã được tải lên thành công</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
