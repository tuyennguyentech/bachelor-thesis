"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { UploadCloudIcon, CheckCircleIcon, Loader2Icon } from "lucide-react";

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

export function VideoUpload({ lessonId, moduleId, courseId, slug, hasVideo, token }: Props) {
  const router = useRouter();
  const storageClient = useRichterWebClient(StorageService, token);
  const lessonClient = useRichterWebClient(LessonService, token);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setDone(false);

    if (!file.type.startsWith("video/") || !ALLOWED_CONTENT_TYPES.has(file.type)) {
      setError("Chỉ hỗ trợ tệp video (mp4, webm, mov…).");
      return;
    }

    setProgress(0);

    const ext = file.name.split(".").pop() ?? "mp4";
    const key = `lessons/${lessonId}/video.${ext}`;

    let uploadUrl: string;
    try {
      const res = await storageClient.getUploadUrl({ key, contentType: file.type || "video/mp4", expiresInSeconds: 3600 });
      uploadUrl = res.uploadUrl;
    } catch {
      setError("Không lấy được URL upload. Kiểm tra kết nối storage.");
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
          reject(new Error(`Upload thất bại (HTTP ${xhr.status})`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Lỗi mạng khi tải lên")));
      xhr.addEventListener("timeout", () => reject(new Error("Upload quá thời gian. Thử lại sau.")));
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
        const timer = setTimeout(() => { cleanup(); resolve(0); }, 10_000);
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
    <div className="flex flex-col gap-3">
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
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Đang tải lên… {progress}%
          </div>
          <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : (
        <>
          {done && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircleIcon className="size-4" />
              Video đã được tải lên thành công
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => inputRef.current?.click()}
            className="gap-2 self-start"
          >
            <UploadCloudIcon className="size-4" />
            {hasVideo || done ? "Thay video" : "Tải video lên"}
          </Button>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
