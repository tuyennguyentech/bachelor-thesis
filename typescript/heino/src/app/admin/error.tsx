"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/lib/connect-error";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[AdminError]", error);
  }, [error]);

  const message = toUserMessage(error);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="text-center max-w-sm">
        <AlertTriangleIcon className="mx-auto mb-4 size-10 text-destructive" />
        <h2 className="text-lg font-semibold mb-2">Không thể tải trang</h2>
        <p className="text-muted-foreground text-sm mb-6">{message}</p>
        <div className="flex items-center justify-center gap-2">
          <Button onClick={reset}>Thử lại</Button>
          <Button variant="outline" asChild>
            <Link href="/admin">Về trang quản trị</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
