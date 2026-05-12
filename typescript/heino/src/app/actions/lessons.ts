"use server";

import { revalidatePath } from "next/cache";
import { createRichterClient } from "@/lib/connect-client";
import { requireAnyUser } from "@/lib/auth";
import { LessonService } from "buf/gen/richter/v1/courses_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

function revalidateLessonPaths(slug: string, courseId: string, moduleId: string) {
  revalidatePath(`/admin/organizations/${slug}/courses/${courseId}/modules/${moduleId}`);
  revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
}

export async function createLesson(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(LessonService, token);

  const moduleId = formData.get("moduleId") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() ?? "";
  const orderIndex = parseInt(formData.get("orderIndex") as string) || 0;
  const slug = formData.get("slug") as string;
  const courseId = formData.get("courseId") as string;

  if (!moduleId || !title) return { error: "Vui lòng điền đầy đủ thông tin" };

  try {
    await client.createLesson({ moduleId, title, description, orderIndex });
    revalidateLessonPaths(slug, courseId, moduleId);
    return { success: true };
  } catch {
    return { error: "Không thể tạo bài học" };
  }
}

export async function updateLesson(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(LessonService, token);

  const id = formData.get("id") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() ?? "";
  const orderIndex = parseInt(formData.get("orderIndex") as string) || 0;
  const slug = formData.get("slug") as string;
  const courseId = formData.get("courseId") as string;
  const moduleId = formData.get("moduleId") as string;

  if (!id || !title) return { error: "Tên không được để trống" };

  try {
    await client.updateLesson({ id, title, description, orderIndex });
    revalidateLessonPaths(slug, courseId, moduleId);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật bài học" };
  }
}

export async function updateLessonVideo(
  id: string,
  videoStorageKey: string,
  durationSeconds: number,
  slug: string,
  courseId: string,
  moduleId: string,
): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(LessonService, token);
  try {
    await client.updateLessonVideo({ id, videoStorageKey, durationSeconds });
    revalidateLessonPaths(slug, courseId, moduleId);
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${id}`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật video bài học" };
  }
}

export async function deleteLesson(
  id: string,
  slug: string,
  courseId: string,
  moduleId: string,
): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(LessonService, token);
  try {
    await client.deleteLesson({ id });
    revalidateLessonPaths(slug, courseId, moduleId);
    return { success: true };
  } catch {
    return { error: "Không thể xóa bài học" };
  }
}
