"use server";

import { revalidatePath } from "next/cache";
import { createRichterClient } from "@/lib/connect-client";
import { requireAdmin } from "@/lib/auth";
import { OrganizationMemberService, OrganizationRole, MemberStatus } from "buf/gen/richter/v1/organization_members_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

export async function addMember(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationMemberService, token);

  const organizationId = formData.get("organizationId") as string;
  const userId = formData.get("userId") as string;
  const role = parseInt(formData.get("role") as string) as OrganizationRole;
  const slug = formData.get("slug") as string;

  if (!organizationId || !userId) return { error: "Vui lòng điền đầy đủ thông tin" };
  if (isNaN(role)) return { error: "Vai trò không hợp lệ" };

  try {
    await client.addOrganizationMember({ organizationId, userId, role });
    revalidatePath(`/admin/organizations/${slug}/members`);
    return { success: true };
  } catch {
    return { error: "Không thể thêm thành viên" };
  }
}

export async function updateMemberRole(
  organizationId: string,
  userId: string,
  role: OrganizationRole,
  slug: string,
): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationMemberService, token);
  try {
    await client.updateOrganizationMemberRole({ organizationId, userId, role });
    revalidatePath(`/admin/organizations/${slug}/members`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật vai trò" };
  }
}

export async function updateMemberStatus(
  organizationId: string,
  userId: string,
  status: MemberStatus,
  slug: string,
): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationMemberService, token);
  try {
    await client.updateOrganizationMemberStatus({ organizationId, userId, status });
    revalidatePath(`/admin/organizations/${slug}/members`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật trạng thái" };
  }
}

export async function removeMember(
  organizationId: string,
  userId: string,
  slug: string,
): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationMemberService, token);
  try {
    await client.removeOrganizationMember({ organizationId, userId });
    revalidatePath(`/admin/organizations/${slug}/members`);
    return { success: true };
  } catch {
    return { error: "Không thể xóa thành viên" };
  }
}
