"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createRichterClient } from "@/lib/connect-client";
import { requireAnyUser } from "@/lib/auth";
import { CourseService, CourseStatus } from "buf/gen/richter/v1/courses_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

function revalidateCourseList(slug: string) {
  revalidatePath(`/admin/organizations/${slug}/courses`);
  revalidatePath(`/dashboard/organizations/${slug}/courses`);
}

function revalidateCourseDetail(slug: string, courseId: string) {
  revalidatePath(`/admin/organizations/${slug}/courses/${courseId}`);
  revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
}

export async function createCourse(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { claims, token } = await requireAnyUser();
  const client = createRichterClient(CourseService, token);

  const organizationId = formData.get("organizationId") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() ?? "";
  const slug = formData.get("slug") as string;

  if (!organizationId || !title) return { error: "Vui lòng điền đầy đủ thông tin" };

  try {
    await client.createCourse({ organizationId, ownerId: claims.sub, title, description });
    revalidateCourseList(slug);
    return { success: true };
  } catch {
    return { error: "Không thể tạo khóa học" };
  }
}

export async function updateCourse(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(CourseService, token);

  const id = formData.get("id") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() ?? "";
  const slug = formData.get("slug") as string;
  const courseId = formData.get("courseId") as string;

  if (!title) return { error: "Tên không được để trống" };

  try {
    await client.updateCourse({ id, title, description });
    revalidateCourseList(slug);
    revalidateCourseDetail(slug, courseId);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật khóa học" };
  }
}

export async function updateCourseStatus(
  id: string,
  slug: string,
  courseId: string,
  status: CourseStatus,
): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(CourseService, token);
  try {
    await client.updateCourseStatus({ id, status });
    revalidateCourseList(slug);
    revalidateCourseDetail(slug, courseId);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật trạng thái" };
  }
}

export async function deleteCourse(id: string, slug: string, redirectTo?: string): Promise<void> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(CourseService, token);
  try {
    await client.deleteCourse({ id });
  } catch {
    return;
  }
  redirect(redirectTo ?? `/admin/organizations/${slug}/courses`);
}
