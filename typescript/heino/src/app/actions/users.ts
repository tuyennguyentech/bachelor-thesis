"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createRichterClient } from "@/lib/connect-client";
import { requireAdmin } from "@/lib/auth";
import { UserService, UserRole, UserStatus } from "buf/gen/richter/v1/users_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

export async function createUser(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(UserService, token);

  const email = (formData.get("email") as string)?.trim();
  const password = formData.get("password") as string;
  const firstName = (formData.get("firstName") as string)?.trim();
  const lastName = (formData.get("lastName") as string)?.trim();
  const role = parseInt(formData.get("role") as string) as UserRole;
  const status = parseInt(formData.get("status") as string) as UserStatus;

  if (!email || !password || !firstName || !lastName) {
    return { error: "Vui lòng điền đầy đủ thông tin" };
  }
  if (isNaN(role) || isNaN(status)) {
    return { error: "Vai trò hoặc trạng thái không hợp lệ" };
  }

  try {
    await client.createUserWithRoleAndStatus({ email, password, firstName, lastName, role, status });
    revalidatePath("/admin/users");
    return { success: true };
  } catch {
    return { error: "Không thể tạo người dùng" };
  }
}

export async function updateUserStatus(id: string, status: UserStatus): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(UserService, token);
  try {
    await client.updateUserStatus({ id, status });
    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${id}`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật trạng thái" };
  }
}

export async function updateUserRole(id: string, role: UserRole): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(UserService, token);
  try {
    await client.updateUserRole({ id, role });
    revalidatePath(`/admin/users/${id}`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật vai trò" };
  }
}

export async function updateUserProfile(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(UserService, token);

  const id = formData.get("id") as string;
  const firstName = (formData.get("firstName") as string)?.trim();
  const lastName = (formData.get("lastName") as string)?.trim();
  const middleName = (formData.get("middleName") as string)?.trim() || undefined;

  try {
    await client.updateUserProfile({ id, firstName, lastName, middleName });
    revalidatePath(`/admin/users/${id}`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật thông tin" };
  }
}

export async function updateUserPassword(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(UserService, token);

  const id = formData.get("id") as string;
  const password = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;

  if (!password || password.length < 8) {
    return { error: "Mật khẩu phải có ít nhất 8 ký tự" };
  }
  if (password !== confirm) {
    return { error: "Mật khẩu xác nhận không khớp" };
  }

  try {
    await client.updateUserPassword({ id, password });
    return { success: true };
  } catch {
    return { error: "Không thể đổi mật khẩu" };
  }
}

export async function deleteUser(id: string): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(UserService, token);
  try {
    await client.deleteUser({ id });
  } catch {
    return { error: "Không thể xóa người dùng" };
  }
  redirect("/admin/users");
}
