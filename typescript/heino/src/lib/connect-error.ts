import { ConnectError, Code } from "@connectrpc/connect";

/**
 * toUserMessage converts any error (ConnectError, TypeError, Error)
 * into a user-friendly Vietnamese message. Safe to call with any
 * value — never throws.
 */
export function toUserMessage(
  err: unknown,
  fallback = "Đã xảy ra lỗi. Vui lòng thử lại.",
): string {
  if (err instanceof ConnectError) {
    return connectErrorToMessage(err, fallback);
  }
  if (err instanceof TypeError) {
    // fetch failed, network error, etc.
    if (
      err.message.includes("fetch") ||
      err.message.includes("ECONNREFUSED") ||
      err.message.includes("network")
    ) {
      return "Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.";
    }
  }
  if (err instanceof Error) {
    if (
      err.message.includes("ECONNREFUSED") ||
      err.message.includes("connect ECONNREFUSED")
    ) {
      return "Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.";
    }
    if (err.message.includes("timeout") || err.message.includes("Timeout")) {
      return "Máy chủ phản hồi quá chậm. Vui lòng thử lại.";
    }
  }
  return fallback;
}

function connectErrorToMessage(err: ConnectError, fallback: string): string {
  switch (err.code) {
    case Code.Unavailable:
    case Code.DeadlineExceeded:
      return "Máy chủ tạm thời không phản hồi. Vui lòng thử lại sau ít phút.";
    case Code.Unauthenticated:
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case Code.PermissionDenied:
      return "Bạn không có quyền thực hiện thao tác này.";
    case Code.NotFound:
      return "Không tìm thấy dữ liệu yêu cầu.";
    case Code.AlreadyExists:
      return "Dữ liệu đã tồn tại.";
    case Code.ResourceExhausted:
      return "Quá nhiều yêu cầu. Vui lòng chờ một lát rồi thử lại.";
    case Code.FailedPrecondition:
      // Extract the human-readable part after the code prefix.
      return err.rawMessage || "Điều kiện tiên quyết chưa được đáp ứng.";
    case Code.InvalidArgument:
      return err.rawMessage || "Dữ liệu không hợp lệ.";
    case Code.Internal:
      return "Lỗi hệ thống nội bộ. Vui lòng thử lại.";
    case Code.Aborted:
      return "Thao tác bị hủy. Vui lòng thử lại.";
    default:
      return fallback;
  }
}

/**
 * isTransientError returns true for errors that may resolve on retry,
 * i.e. the backend is unreachable rather than rejecting the request
 * (connection refused, 502/503, timeout, gRPC Unavailable/DeadlineExceeded).
 *
 * Single source of truth — used by the web client retry, the silent-refresh
 * path, and the auth proxy to distinguish "backend down" from "token expired".
 * Matching is case-insensitive and walks the Error `cause` chain because
 * undici wraps the real connection failure (e.g. ECONNREFUSED) under a
 * generic "fetch failed" message.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ConnectError) {
    return err.code === Code.Unavailable || err.code === Code.DeadlineExceeded;
  }
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 5; depth++) {
    const msg = cur.message.toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("unavailable") ||
      msg.includes("timeout") ||
      msg.includes("502") ||
      msg.includes("503")
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
