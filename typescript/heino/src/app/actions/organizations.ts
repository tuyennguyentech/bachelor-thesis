"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createRichterClient } from "@/lib/connect-client";
import { requireAdmin } from "@/lib/auth";
import { OrganizationService, OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";

export type ActionState = { error?: string; success?: boolean } | undefined;

export async function createOrganization(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationService, token);

  const name = (formData.get("name") as string)?.trim();
  const slug = (formData.get("slug") as string)?.trim();
  const createdBy = (formData.get("createdBy") as string)?.trim();

  if (!name || !slug || !createdBy) return { error: "Vui lòng điền đầy đủ thông tin" };

  try {
    await client.createOrganization({ name, slug, createdBy });
    revalidatePath("/admin/organizations");
    return { success: true };
  } catch {
    return { error: "Không thể tạo tổ chức" };
  }
}

export async function updateOrganization(_state: ActionState, formData: FormData): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationService, token);

  const id = formData.get("id") as string;
  const name = (formData.get("name") as string)?.trim();

  if (!name) return { error: "Tên không được để trống" };

  try {
    await client.updateOrganization({ id, name });
    revalidatePath("/admin/organizations");
    revalidatePath(`/admin/organizations/${formData.get("slug")}`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật tổ chức" };
  }
}

export async function updateOrganizationStatus(id: string, slug: string, status: OrganizationStatus): Promise<ActionState> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationService, token);
  try {
    await client.updateOrganizationStatus({ id, status });
    revalidatePath("/admin/organizations");
    revalidatePath(`/admin/organizations/${slug}`);
    return { success: true };
  } catch {
    return { error: "Không thể cập nhật trạng thái" };
  }
}

export async function deleteOrganization(id: string): Promise<void> {
  const { token } = await requireAdmin();
  const client = createRichterClient(OrganizationService, token);
  try {
    await client.deleteOrganization({ id });
  } catch {
    return;
  }
  redirect("/admin/organizations");
}
