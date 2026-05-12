"use server";

import { revalidatePath } from "next/cache";
import { createRichterClient } from "@/lib/connect-client";
import { requireAnyUser } from "@/lib/auth";
import { OrganizationMemberService, OrganizationRole, MemberStatus } from "buf/gen/richter/v1/organization_members_pb";
import { UserService } from "buf/gen/richter/v1/users_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

function revalidateMemberPaths(slug: string) {
  revalidatePath(`/admin/organizations/${slug}/members`);
  revalidatePath(`/dashboard/organizations/${slug}/members`);
  revalidatePath(`/dashboard/organizations/${slug}`);
}

export async function addMember(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(OrganizationMemberService, token);

  const organizationId = formData.get("organizationId") as string;
  const email = (formData.get("email") as string)?.trim();
  const role = parseInt(formData.get("role") as string) as OrganizationRole;
  const slug = formData.get("slug") as string;

  if (!organizationId || !email) return { error: "Vui lòng điền đầy đủ thông tin" };
  if (isNaN(role)) return { error: "Vai trò không hợp lệ" };

  try {
    const userClient = createRichterClient(UserService, token);
    const res = await userClient.getUserByEmail({ email });
    if (!res.user) return { error: "Không tìm thấy người dùng với email này" };
    await client.addOrganizationMember({ organizationId, userId: res.user.id, role, status: MemberStatus.ACTIVE });
    revalidateMemberPaths(slug);
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
  const { token } = await requireAnyUser();
  const client = createRichterClient(OrganizationMemberService, token);
  try {
    await client.updateOrganizationMemberRole({ organizationId, userId, role });
    revalidateMemberPaths(slug);
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
  const { token } = await requireAnyUser();
  const client = createRichterClient(OrganizationMemberService, token);
  try {
    await client.updateOrganizationMemberStatus({ organizationId, userId, status });
    revalidateMemberPaths(slug);
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
  const { token } = await requireAnyUser();
  const client = createRichterClient(OrganizationMemberService, token);
  try {
    await client.removeOrganizationMember({ organizationId, userId });
    revalidateMemberPaths(slug);
    return { success: true };
  } catch {
    return { error: "Không thể xóa thành viên" };
  }
}
