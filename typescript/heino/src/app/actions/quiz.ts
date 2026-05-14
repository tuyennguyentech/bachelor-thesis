"use server";

import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { QuizService } from "buf/gen/richter/v1/quiz_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { revalidatePath } from "next/cache";

export type QuizActionState = {
  error?: string;
  score?: number;
  total?: number;
  correctAnswers?: number[];
} | undefined;

export async function submitQuiz(
  lessonId: string,
  answers: number[],
  slug: string,
  courseId: string,
): Promise<QuizActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(QuizService, token);
  const lessonPath = `/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}`;
  try {
    const res = await client.submitQuiz({ lessonId, answers });
    revalidatePath(lessonPath);

    // Return correct answers so the client can highlight right/wrong after first submission.
    const aiClient = createRichterClient(AIService, token);
    const analysis = await aiClient.getLessonAnalysis({ lessonId }).catch(() => null);
    const questions = analysis?.analysis?.questions;
    const correctAnswers = questions && questions.length > 0
      ? questions.map((q) => q.correctAnswer)
      : undefined;

    return { score: res.attempt?.score ?? 0, total: res.attempt?.total ?? 0, correctAnswers };
  } catch {
    return { error: "Nộp bài thất bại. Vui lòng thử lại." };
  }
}

export async function getMyQuizAttempt(lessonId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(QuizService, token);
  try {
    const res = await client.getMyQuizAttempt({ lessonId });
    return res.attempt ?? null;
  } catch {
    return null;
  }
}

export async function listLessonAttempts(lessonId: string, limit = 50, offset = 0) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(QuizService, token);
  try {
    const res = await client.listLessonAttempts({ lessonId, limit, offset });
    return { attempts: res.attempts, total: res.total };
  } catch {
    return { attempts: [], total: 0 };
  }
}
