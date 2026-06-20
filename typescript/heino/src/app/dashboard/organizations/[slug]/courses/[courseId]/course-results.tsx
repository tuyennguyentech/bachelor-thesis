import { createRichterClient } from "@/lib/connect-client";
import {
  InteractionService,
  type CourseStudentSummary,
  type AtRiskStudent,
} from "buf/gen/richter/v1/interactions_pb";
import { formatDate } from "@/lib/date-utils";
import { toUserMessage } from "@/lib/connect-error";
import {
  CourseResultsView,
  type ResultRow,
  type AtRiskRow,
} from "./course-results-view";

const LIMIT = 20;

interface CourseResultsProps {
  courseId: string;
  token: string;
  page?: number;
  initialSub?: "list" | "distribution" | "scatter" | "at-risk";
}

export async function CourseResults({ courseId, token, page = 1, initialSub }: CourseResultsProps) {
  const client = createRichterClient(InteractionService, token);
  const currentPage = Math.max(1, page);
  let students: CourseStudentSummary[] = [];
  let loadError: string | null = null;
  let atRiskRaw: AtRiskStudent[] = [];
  try {
    const [summaryRes, atRiskRes] = await Promise.all([
      client.listCourseAttemptsSummary({
        courseId,
        limit: LIMIT,
        offset: (currentPage - 1) * LIMIT,
      }),
      client
        .listAtRiskStudents({ courseId, limit: LIMIT, offset: 0 })
        .catch((err) => {
          console.error("[course-results] listAtRiskStudents failed:", err);
          return null;
        }),
    ]);
    students = summaryRes.students ?? [];
    atRiskRaw = atRiskRes?.students ?? [];
  } catch (err) {
    loadError = toUserMessage(err, "Không thể tải dữ liệu kết quả học tập.");
  }

  const atRiskIds = new Set(atRiskRaw.map((s) => s.userId));
  const hasNext = students.length === LIMIT;

  // Shape the proto messages into plain, serializable rows for the client view.
  const rows: ResultRow[] = students.map((s) => {
    const hasAttempt = !!s.lastActive;
    return {
      userId: s.userId,
      displayName: s.displayName,
      email: s.email,
      lessonsCompleted: s.lessonsCompleted,
      lessonsTotal: s.lessonsTotal,
      avgScorePct: Math.round(s.avgScore * 100),
      responseRatePct: Math.round(s.responseRate * 100),
      watchPct: Math.round(s.avgVideoWatchFraction * 100),
      engagementScore: s.engagementScore,
      lastActive: s.lastActive ? formatDate(s.lastActive) : null,
      hasAttempt,
      // The "Cần chú ý" list tag means exactly the same as the "Cần chú ý" tab:
      // a student flagged at-risk (a run of consecutive low-engagement lessons).
      // Low average score alone is still visible via the red score column, so it
      // doesn't need a separate broader flag that would diverge from the tab.
      flagged: atRiskIds.has(s.userId),
      totalScore: s.totalScore,
      totalMaxScore: s.totalMaxScore,
      totalResponses: s.totalResponses,
      totalInteractions: s.totalInteractions,
      totalTimeMs: s.totalTimeMs,
    };
  });

  const atRisk: AtRiskRow[] = atRiskRaw.map((s) => ({
    userId: s.userId,
    label: s.displayName || s.email || s.userId,
    lowStreakCount: s.lowStreak.length,
    lowStreak: s.lowStreak.map((p) => ({ label: p.lessonTitle, score: p.engagementScore })),
  }));

  return (
    <CourseResultsView
      rows={rows}
      atRisk={atRisk}
      page={currentPage}
      hasNext={hasNext}
      loadError={loadError}
      initialSub={initialSub}
    />
  );
}
