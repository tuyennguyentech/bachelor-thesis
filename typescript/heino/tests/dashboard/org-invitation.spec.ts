/**
 * E2E — self-service organization invitation accept / decline + permission edge cases.
 */
import { createClient, ConnectError, Code } from "@connectrpc/connect";
import {
  test,
  expect,
  loginAs,
  getAdminAuth,
  getToken,
  createUser,
  getOrgId,
  uid,
  createAuthedTransport,
  USER_PASSWORD,
} from "../fixtures";
import {
  OrganizationMemberService,
  MemberStatus,
  OrganizationRole,
} from "buf/gen/richter/v1/organization_members_pb";

const ORG = "hust-cs";

function memberClient(token: string, baseURL?: string) {
  return createClient(OrganizationMemberService, createAuthedTransport(token, baseURL));
}
async function invite(adminToken: string, orgId: string, userId: string, baseURL?: string) {
  await memberClient(adminToken, baseURL).addOrganizationMember({
    organizationId: orgId, userId, role: OrganizationRole.STUDENT, status: MemberStatus.INVITED,
  });
}
/** Create a fresh user, optionally invite them to hust-cs. Returns email + ids. */
async function freshUser(adminToken: string, orgId: string, doInvite: boolean, baseURL?: string) {
  const email = `invitee-${uid("")}@dyadia.local`;
  const userId = await createUser(adminToken, { email, firstName: "Khách", lastName: "Mời" }, baseURL);
  if (doInvite) await invite(adminToken, orgId, userId, baseURL);
  return { email, userId };
}
async function codeOf(p: Promise<unknown>): Promise<Code | "ok"> {
  try { await p; return "ok"; } catch (e) { return e instanceof ConnectError ? e.code : Code.Unknown; }
}

test.use({ viewport: { width: 1380, height: 900 } });

test.describe("Organization invitation — UI flow", () => {
  test("invited user sees a pending card in a dedicated section, accepts, gains access", async ({ page, baseURL }) => {
    test.setTimeout(90000);
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email } = await freshUser(adminToken, orgId, true, baseURL);

    await loginAs(page, email, USER_PASSWORD, baseURL);
    await page.goto("/dashboard/organizations", { waitUntil: "domcontentloaded" });

    // Pending invitations live in their own prominent section.
    const section = page.getByTestId("invitations-section");
    await expect(section).toBeVisible({ timeout: 20000 });
    await expect(section.getByText("Lời mời tham gia")).toBeVisible();
    const card = section.getByTestId("org-card").first();
    await expect(card.getByText("HUST Computer Science").first()).toBeVisible();
    await expect(card.getByTestId("invite-accept")).toBeVisible();

    await card.getByTestId("invite-accept").click();
    await page.waitForURL(new RegExp(`/dashboard/organizations/${ORG}(\\b|/|$)`), { timeout: 20000 });
    await expect(page.getByText("Thành viên: Đang hoạt động")).toBeVisible({ timeout: 15000 });
  });

  test("decline asks for confirmation, then removes the membership", async ({ page, baseURL }) => {
    test.setTimeout(90000);
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email } = await freshUser(adminToken, orgId, true, baseURL);

    await loginAs(page, email, USER_PASSWORD, baseURL);
    await page.goto("/dashboard/organizations", { waitUntil: "domcontentloaded" });
    await page.getByTestId("invite-decline").first().waitFor({ timeout: 20000 });

    // First click only opens the confirmation dialog — membership still there.
    await page.getByTestId("invite-decline").first().click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByText("Từ chối lời mời?")).toBeVisible();
    await expect(page.getByTestId("org-card")).toHaveCount(1);

    // Confirm → membership removed → empty state.
    await page.getByTestId("invite-decline-confirm").click();
    await expect(page.getByText("Bạn chưa tham gia tổ chức nào")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("org-card")).toHaveCount(0);
  });

  test("invited user navigating directly to the org is routed to their invitation, not a 404", async ({ page, baseURL }) => {
    test.setTimeout(90000);
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email } = await freshUser(adminToken, orgId, true, baseURL);

    await loginAs(page, email, USER_PASSWORD, baseURL);
    await page.goto(`/dashboard/organizations/${ORG}`, { waitUntil: "domcontentloaded" });
    // Redirected to the org list (where the invite card lives) — NOT a 404.
    await expect(page).toHaveURL(/\/dashboard\/organizations(\?|$)/, { timeout: 20000 });
    await expect(page.getByText("Không tìm thấy tổ chức")).toHaveCount(0);
    await expect(page.getByTestId("invitations-section")).toBeVisible();
  });
});

test.describe("Organization invitation — permissions / edge cases (RPC)", () => {
  test("an active member cannot 'respond' (no pending invitation) → FailedPrecondition", async ({ baseURL }) => {
    const orgId = await getOrgId((await getAdminAuth(baseURL)).token, ORG, baseURL);
    const aliceToken = await getToken("alice@dyadia.local", USER_PASSWORD, baseURL); // active hust-cs member
    expect(await codeOf(memberClient(aliceToken, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true })))
      .toBe(Code.FailedPrecondition);
  });

  test("double-accept is rejected (second accept has no pending invitation)", async ({ baseURL }) => {
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email } = await freshUser(adminToken, orgId, true, baseURL);
    const t = await getToken(email, USER_PASSWORD, baseURL);
    expect(await codeOf(memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true }))).toBe("ok");
    expect(await codeOf(memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true }))).toBe(Code.FailedPrecondition);
  });

  test("a non-member cannot respond → NotFound", async ({ baseURL }) => {
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email } = await freshUser(adminToken, orgId, false, baseURL); // created but NOT invited
    const t = await getToken(email, USER_PASSWORD, baseURL);
    expect(await codeOf(memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true }))).toBe(Code.NotFound);
  });

  test("a member whose invitation was suspended cannot accept → FailedPrecondition", async ({ baseURL }) => {
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email, userId } = await freshUser(adminToken, orgId, true, baseURL);
    await memberClient(adminToken, baseURL).updateOrganizationMemberStatus({ organizationId: orgId, userId, status: MemberStatus.SUSPENDED });
    const t = await getToken(email, USER_PASSWORD, baseURL);
    expect(await codeOf(memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true }))).toBe(Code.FailedPrecondition);
  });

  test("decline-then-reinvite: user can accept after being invited again", async ({ baseURL }) => {
    const { token: adminToken } = await getAdminAuth(baseURL);
    const orgId = await getOrgId(adminToken, ORG, baseURL);
    const { email, userId } = await freshUser(adminToken, orgId, true, baseURL);
    const t = await getToken(email, USER_PASSWORD, baseURL);
    // Decline → membership removed.
    expect(await codeOf(memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: false }))).toBe("ok");
    // Responding again now fails (no membership).
    expect(await codeOf(memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true }))).toBe(Code.NotFound);
    // Admin re-invites (PK conflict would prove the row wasn't deleted) → accept works.
    await invite(adminToken, orgId, userId, baseURL);
    const r = await memberClient(t, baseURL).respondToOrganizationInvitation({ organizationId: orgId, accept: true });
    expect(r.member?.status).toBe(MemberStatus.ACTIVE);
  });
});
