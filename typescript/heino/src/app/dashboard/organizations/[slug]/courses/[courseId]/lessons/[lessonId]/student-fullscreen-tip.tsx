"use client";

import { Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";

interface StudentFullscreenTipProps {
  onDismiss: () => void;
  onEnable: () => void;
}

export function StudentFullscreenTip({ onDismiss, onEnable }: StudentFullscreenTipProps) {
  return (
    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center text-white select-none">
      <div className="max-w-md flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-200">
        <div className="size-14 rounded-full bg-amber-500/10 flex items-center justify-center border border-amber-500/20 text-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.1)]">
          <Maximize className="size-6 animate-pulse" />
        </div>
        <h3 className="text-lg font-semibold tracking-tight text-white">Bật Toàn Màn Hình Có Bài Tập</h3>
        <p className="text-sm text-zinc-300 leading-relaxed px-4">
          Để làm được các câu hỏi tương tác trong lúc xem video, bạn hãy sử dụng tính năng <strong>Toàn màn hình chuẩn</strong> của trình phát.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 mt-4 w-full px-8">
          <Button
            onClick={onEnable}
            className="flex-1 bg-white hover:bg-zinc-200 text-black font-semibold rounded-full py-5 shadow-sm transition-all duration-200"
          >
            Bật ngay
          </Button>
          <Button
            variant="ghost"
            onClick={onDismiss}
            className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 rounded-full py-5 transition-all duration-200"
          >
            Để sau
          </Button>
        </div>
      </div>
    </div>
  );
}
