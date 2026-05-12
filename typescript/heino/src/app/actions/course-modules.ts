"use server";

import { revalidatePath } from "next/cache";
import { createRichterClient } from "@/lib/connect-client";
import { requireAnyUser } from "@/lib/auth";
import { CourseModuleService } from "buf/gen/richter/v1/courses_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

function revalidateCourseDetail(slug: string, courseId: string) {
  revalidatePath(`/admin/organizations/${slug}/courses/${courseId}`);
  revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
}

export async function createCourseModule(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(CourseModuleService, token);

  const courseId = formData.get("courseId") as string;
  const title = (formData.get("title") as string)?.trim();
  const orderIndex = parseInt(formData.get("orderIndex") as string) || 0;
  const slug = formData.get("slug") as string;

  if (!courseId || !title) return { error: "Vui lòng điền đầy đủ thông tin" };

  try {
    await client.createCourseModule({ courseId, title, orderIndex });
    revalidateCourseDetail(slug, courseId);
    return { success: true };
  } catch {
    return { error: "Không thể tạo chương" };
  }
}

export async function updateCourseModule(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(CourseModuleService, token);

  const id = formData.get("id") as string;
  const title = (formData.get("title") as string)?.trim();
  const orderIndex = parseInt(formData.get("orderIndex") as string) || 0;
  const slug = formData.get("slug") as string;
  const courseId = formData.get("courseId") as string;

  if (!id || !title) return { error: "Tên không được để trống" };

  try {
    await client.updateCourseModule({ id, title, orderIndex });
    revalidateCourseDetail(slug, courseId);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật chương" };
  }
}

export async function deleteCourseModule(
  id: string,
  slug: string,
  courseId: string,
): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(CourseModuleService, token);
  try {
    await client.deleteCourseModule({ id });
    revalidateCourseDetail(slug, courseId);
    return { success: true };
  } catch {
    return { error: "Không thể xóa chương" };
  }
}
