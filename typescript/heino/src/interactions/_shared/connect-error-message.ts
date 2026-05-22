import { Code, ConnectError } from "@connectrpc/connect";

// User-facing Vietnamese message for an inline grading failure (PreviewGrade).
// Surfaces only one of three intents instead of leaking raw "[unavailable] HTTP 502".
export function previewGradeErrorMessage(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.Unavailable:
      case Code.DeadlineExceeded:
        return "Hệ thống AI tạm thời quá tải, hãy thử ghi âm lại.";
      case Code.FailedPrecondition:
        return "Chưa thể chấm điểm ngay — lớp học chưa bật chế độ phản hồi tức thì.";
      default:
        return "Chưa chấm được phần ghi âm này. Giáo viên sẽ xem lại khi bạn nộp bài.";
    }
  }
  return "Chưa chấm được phần ghi âm này. Giáo viên sẽ xem lại khi bạn nộp bài.";
}

// User-facing Vietnamese message for a lesson SubmitAttempt failure. Same
// taxonomy but the wording reflects the end-of-lesson context.
export function submitAttemptErrorMessage(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.Unavailable:
      case Code.DeadlineExceeded:
        return "Hệ thống đang xử lý chậm. Hãy thử lại sau ít phút — bài làm của bạn chưa bị mất.";
      case Code.Unauthenticated:
        return "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi nộp bài.";
      default:
        return "Không nộp được bài. Vui lòng thử lại.";
    }
  }
  return "Không nộp được bài. Vui lòng thử lại.";
}
