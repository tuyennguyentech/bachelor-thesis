"use client";

import { useState, useRef, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getUploadUrl } from "@/app/actions/storage";
import { updateLessonVideo } from "@/app/actions/lessons";
import { UploadCloudIcon, CheckCircleIcon, Loader2Icon } from "lucide-react";

interface Props {
  lessonId: string;
  moduleId: string;
  courseId: string;
  slug: string;
  hasVideo: boolean;
}

export function VideoUpload({ lessonId, moduleId, courseId, slug, hasVideo }: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setDone(false);
    setProgress(0);

    const ext = file.name.split(".").pop() ?? "mp4";
    const key = `lessons/${lessonId}/video.${ext}`;

    let uploadUrl: string;
    try {
      uploadUrl = await getUploadUrl(key, file.type || "video/mp4");
    } catch {
      setError("Không lấy được URL upload. Kiểm tra kết nối storage.");
      setProgress(null);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed: ${xhr.status}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
      xhr.send(file);
    }).catch((e: Error) => {
      setError(e.message);
      setProgress(null);
    });

    if (error) return;

    startTransition(async () => {
      await updateLessonVideo(lessonId, key, 0, slug, courseId, moduleId);
      setProgress(null);
      setDone(true);
    });
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
      ) : done ? (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <CheckCircleIcon className="size-4" />
          Video đã được tải lên thành công
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => inputRef.current?.click()}
          className="gap-2 self-start"
        >
          <UploadCloudIcon className="size-4" />
          {hasVideo ? "Thay video" : "Tải video lên"}
        </Button>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
