"use client";

import { useEffect } from "react";
import { toUserMessage } from "@/lib/connect-error";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  const message = toUserMessage(error);
  const isConnectionError =
    message.includes("kết nối") ||
    message.includes("phản hồi") ||
    message.includes("máy chủ");

  return (
    <html lang="vi">
      <body
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "system-ui, sans-serif",
          backgroundColor: "#f9fafb",
          color: "#111827",
          margin: 0,
          padding: "1rem",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "28rem" }}>
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>
            {isConnectionError ? "🔌" : "⚠️"}
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            {isConnectionError
              ? "Không thể kết nối máy chủ"
              : "Đã xảy ra lỗi"}
          </h1>
          <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>{message}</p>
          <button
            onClick={reset}
            style={{
              padding: "0.5rem 1.5rem",
              borderRadius: "0.5rem",
              border: "none",
              backgroundColor: "#3b82f6",
              color: "white",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Thử lại
          </button>
        </div>
      </body>
    </html>
  );
}
