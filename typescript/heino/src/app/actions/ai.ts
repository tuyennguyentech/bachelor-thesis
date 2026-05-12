"use server";

import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { revalidatePath } from "next/cache";

export type AIActionState = { error?: string; success?: boolean } | undefined;

export async function analyzeLesson(
  lessonId: string,
  slug: string,
  courseId: string,
): Promise<AIActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    await client.analyzeLesson({ lessonId });
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}`);
    return { success: true };
  } catch (e) {
    return { error: (e as Error).message ?? "Phân tích thất bại" };
  }
}

export async function getLessonAnalysis(lessonId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.getLessonAnalysis({ lessonId });
    return res.analysis ?? null;
  } catch {
    return null;
  }
}
