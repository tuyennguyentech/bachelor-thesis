"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { CourseMemberService, CourseRole } from "buf/gen/richter/v1/course_members_pb";
import { toUserMessage } from "@/lib/connect-error";

export async function createJoinRequestAction(
  slug: string,
  courseId: string,
  requestedRole: CourseRole = CourseRole.STUDENT,
) {
  const session = await getSession();
  if (!session?.token) {
    return { error: "Bạn chưa đăng nhập" };
  }

  try {
    const client = createRichterClient(CourseMemberService, session.token);
    await client.createJoinRequest({ courseId, requestedRole });
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
    return { success: true };
  } catch (err) {
    console.error("Failed to create join request:", err);
    return { error: toUserMessage(err, "Không thể gửi yêu cầu tham gia khóa học") };
  }
}

/**
 * Materialise the caller's OWN course_members row, then redirect them into
 * learn mode. Used for a manager/owner who has bypass access but no explicit
 * membership row yet ("Tham gia học" first-entry flow). The backend only
 * permits self-enrol for bypass callers and is idempotent, so calling it when a
 * row already exists is a harmless no-op. Default role TEACHER (manager).
 */
export async function enrollSelfAction(
  slug: string,
  courseId: string,
  role: CourseRole = CourseRole.TEACHER,
) {
  const session = await getSession();
  if (!session?.token) {
    return { error: "Bạn chưa đăng nhập" };
  }

  try {
    const client = createRichterClient(CourseMemberService, session.token);
    await client.enrollSelf({ courseId, role });
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
    return { success: true };
  } catch (err) {
    console.error("Failed to enrol self:", err);
    return { error: toUserMessage(err, "Không thể tham gia khóa học") };
  }
}

export async function reviewJoinRequestAction(
  slug: string,
  courseId: string,
  userId: string,
  approve: boolean
) {
  const session = await getSession();
  if (!session?.token) {
    return { error: "Bạn chưa đăng nhập" };
  }

  try {
    const client = createRichterClient(CourseMemberService, session.token);
    await client.reviewJoinRequest({ courseId, userId, approve });
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
    return { success: true };
  } catch (err) {
    console.error("Failed to review join request:", err);
    return { error: toUserMessage(err, `Không thể ${approve ? "phê duyệt" : "từ chối"} yêu cầu`) };
  }
}
