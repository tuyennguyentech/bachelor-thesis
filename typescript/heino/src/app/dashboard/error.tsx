"use client";

import { useEffect } from "react";
import { toUserMessage } from "@/lib/connect-error";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[DashboardError]", error);
  }, [error]);

  const message = toUserMessage(error);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">⚠️</div>
        <h2 className="text-lg font-semibold mb-2">Không thể tải trang</h2>
        <p className="text-muted-foreground text-sm mb-6">{message}</p>
        <button
          onClick={reset}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Thử lại
        </button>
      </div>
    </div>
  );
}
