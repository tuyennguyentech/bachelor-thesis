"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationMemberService } from "buf/gen/richter/v1/organization_members_pb";
import { toUserMessage } from "@/lib/connect-error";

/**
 * Accept (or decline) the caller's own pending invitation to an organization.
 * The backend uses the authenticated user as the target, so this can only act on
 * the caller's own invitation.
 */
export async function respondToOrgInvitationAction(orgId: string, accept: boolean) {
  const session = await getSession();
  if (!session?.token) {
    return { error: "Bạn chưa đăng nhập" };
  }
  try {
    const client = createRichterClient(OrganizationMemberService, session.token);
    await client.respondToOrganizationInvitation({ organizationId: orgId, accept });
    revalidatePath("/dashboard/organizations");
    return { success: true };
  } catch (err) {
    console.error("Failed to respond to org invitation:", err);
    return {
      error: toUserMessage(err, accept ? "Không thể chấp nhận lời mời" : "Không thể từ chối lời mời"),
    };
  }
}
