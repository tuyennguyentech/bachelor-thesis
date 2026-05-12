"use server";

import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { QuizService } from "buf/gen/richter/v1/quiz_pb";
import { revalidatePath } from "next/cache";

export type QuizActionState = { error?: string; score?: number; total?: number } | undefined;

export async function submitQuiz(
  lessonId: string,
  answers: number[],
  slug: string,
  courseId: string,
): Promise<QuizActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(QuizService, token);
  try {
    const res = await client.submitQuiz({ lessonId, answers });
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}`);
    return { score: res.attempt?.score ?? 0, total: res.attempt?.total ?? 0 };
  } catch (e) {
    return { error: (e as Error).message ?? "Nộp bài thất bại" };
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
