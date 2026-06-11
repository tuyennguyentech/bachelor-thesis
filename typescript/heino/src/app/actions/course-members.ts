"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { CourseMemberService } from "buf/gen/richter/v1/course_members_pb";

export async function createJoinRequestAction(slug: string, courseId: string) {
  const session = await getSession();
  if (!session?.token) {
    return { error: "Bạn chưa đăng nhập" };
  }

  try {
    const client = createRichterClient(CourseMemberService, session.token);
    await client.createJoinRequest({ courseId });
    revalidatePath(`/dashboard/organizations/${slug}/courses/${courseId}`);
    return { success: true };
  } catch (err) {
    console.error("Failed to create join request:", err);
    return { error: "Không thể gửi yêu cầu tham gia khóa học" };
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
    return { error: `Không thể ${approve ? "phê duyệt" : "từ chối"} yêu cầu` };
  }
}
