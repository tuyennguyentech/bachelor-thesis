"use server";

import { revalidatePath } from "next/cache";
import { createRichterClient } from "@/lib/connect-client";
import { requireAnyUser } from "@/lib/auth";
import { UserService } from "buf/gen/richter/v1/users_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

export async function updateMyProfile(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { claims, token } = await requireAnyUser();
  const client = createRichterClient(UserService, token);

  const firstName = (formData.get("firstName") as string)?.trim();
  const lastName = (formData.get("lastName") as string)?.trim();
  const middleName = (formData.get("middleName") as string)?.trim() || undefined;

  if (!firstName || !lastName) return { error: "Họ và tên không được để trống" };

  try {
    await client.updateUserProfile({ id: claims.sub, firstName, lastName, middleName });
    revalidatePath("/dashboard/profile");
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật thông tin" };
  }
}

export async function updateMyPassword(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { claims, token } = await requireAnyUser();
  const client = createRichterClient(UserService, token);

  const password = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;

  if (!password || password.length < 8) return { error: "Mật khẩu phải có ít nhất 8 ký tự" };
  if (password !== confirm) return { error: "Mật khẩu xác nhận không khớp" };

  try {
    await client.updateUserPassword({ id: claims.sub, password });
    return { success: true };
  } catch {
    return { error: "Không thể đổi mật khẩu" };
  }
}
