"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { AIClient } from "./use-lesson-analysis-state";

interface ResetLessonButtonProps {
  lessonId: string;
  aiClient: AIClient;
}

// ResetLessonButton wipes ALL derived content for a lesson (video, transcript,
// chunks, generated exercises, student attempts) and returns it to its blank
// "before Tạo nhanh" state. Destructive + irreversible, so it sits behind a
// strong confirm that spells out exactly what is deleted. After success we
// router.refresh() so the page re-reads the now-empty lesson.
export function ResetLessonButton({ lessonId, aiClient }: ResetLessonButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setResetting(true);
    setError(null);
    try {
      await aiClient.resetLessonContent({ lessonId });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ConnectError
          ? e.message
          : "Không thể xoá nội dung. Vui lòng thử lại.",
      );
    } finally {
      setResetting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        // Don't let the dialog close mid-delete.
        if (!resetting) {
          setOpen(v);
          if (v) setError(null);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="reset-lesson-button"
          className="ml-auto h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Xoá toàn bộ nội dung
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent data-testid="reset-lesson-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Xoá toàn bộ nội dung bài học?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Hành động này đưa bài học về trạng thái trống ban đầu (như trước
                khi tạo nhanh). Hệ thống sẽ xoá vĩnh viễn:
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                <li>Video đã tải lên</li>
                <li>Bản phiên âm (transcript) và các phân đoạn</li>
                <li>Toàn bộ câu hỏi/bài tập đã tạo</li>
                <li>Mọi bài làm của học viên cho bài học này</li>
              </ul>
              <p className="font-medium text-destructive">
                Không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-xs text-destructive" data-testid="reset-lesson-error">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={resetting}>Huỷ</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              // Keep the dialog mounted while the RPC runs; we close it
              // ourselves on success.
              e.preventDefault();
              void onConfirm();
            }}
            disabled={resetting}
            data-testid="reset-lesson-confirm"
          >
            {resetting ? "Đang xoá..." : "Xoá toàn bộ"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
