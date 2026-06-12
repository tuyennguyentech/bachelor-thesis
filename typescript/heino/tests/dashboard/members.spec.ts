/**
 * E2E tests for dashboard org member management.
 *
 * hust-cs seed roles:
 *   alice  = admin  (userPage)  — canManage
 *   carol  = teacher (teacherPage) — cannot manage members
 *   bob    = student (studentPage) — cannot manage members
 *
 * Isolation strategy (mutation tests):
 *   - Violation E (add member): instead of adding fixed quinn@dyadia.local, a fresh user
 *     is created via API with a unique email. Cleanup (removal) is done in afterEach
 *     via try/finally to avoid cross-run pollution.
 *   - Violation F (role change): instead of changing carol's org role, a fresh user is
 *     created via API and added to hust-cs as teacher via API. The UI role-change flow
 *     runs against that fresh user. Cleanup removes the fresh user in afterEach.
 */

import { test, expect, uid, getAdminAuth, createUser, getOrgId, addOrgMember, OrganizationRole } from "../fixtures";
import type { Locator, Page } from "@playwright/test";

const ORG_SLUG = "hust-cs";
const MEMBERS_URL = `/dashboard/organizations/${ORG_SLUG}/members`;

async function openMemberActions(page: Page, memberRow: Locator) {
  const actionsButton = memberRow.getByRole("button", { name: "Mở menu thao tác thành viên" });
  await expect(actionsButton).toBeVisible();
  await actionsButton.click();
  await expect(page.getByRole("menuitem", { name: "Đổi vai trò" })).toBeVisible();
}

test.describe("Dashboard members page visibility", () => {
  test("shows Thành viên link on org sidebar", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${ORG_SLUG}`);
    await expect(page.getByRole("link", { name: "Thành viên" })).toBeVisible();
  });

  test("link navigates to members page", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${ORG_SLUG}`);
    await page.getByRole("link", { name: "Thành viên" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${ORG_SLUG}/members`));
  });

  test("members page shows table columns", async ({ userPage: page }) => {
    await page.goto(MEMBERS_URL);
    await expect(page.getByRole("columnheader", { name: "Thành viên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
  });

  test("admin sees Thêm thành viên button", async ({ userPage: page }) => {
    await page.goto(MEMBERS_URL);
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).toBeVisible();
  });

  test("teacher does not see Thêm thành viên button", async ({ teacherPage: page }) => {
    await page.goto(MEMBERS_URL);
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).not.toBeVisible();
  });

  test("student does not see Thêm thành viên button", async ({ studentPage: page }) => {
    await page.goto(MEMBERS_URL);
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).not.toBeVisible();
  });

  test("shows seeded members with names and emails", async ({ userPage: page }) => {
    // Alice (seeded admin) may be on the last page because members are ordered by
    // created_at DESC (newest first) and many test runs accumulate fresh members.
    // Navigate through pages until we find her or exhaust all pages.
    let found = false;
    for (let p = 1; p <= 20 && !found; p++) {
      await page.goto(`${MEMBERS_URL}?page=${p}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("table")).toBeVisible();
      const aliceName = page.getByRole("table").getByText("Alice Nguyen");
      const aliceEmail = page.getByText("alice@dyadia.local");
      if (await aliceName.isVisible() && await aliceEmail.isVisible()) {
        found = true;
      }
      // If hasNext (Sau link is absent/not visible), stop — the pagination component uses "Sau" for next
      const hasNext = await page.getByRole("link", { name: "Sau" }).isVisible().catch(() => false);
      if (!found && !hasNext) break;
    }
    expect(found, "Alice Nguyen should appear somewhere in the members list").toBe(true);
  });

  test("back button navigates to org detail", async ({ userPage: page }) => {
    await page.goto(MEMBERS_URL);
    // Back button shows org.name ("HUST Computer Science"), not slug — use href locator
    await page.locator(`a[href='/dashboard/organizations/${ORG_SLUG}']`).first().click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${ORG_SLUG}$`));
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto(MEMBERS_URL);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Dashboard member management lifecycle", () => {
  test("admin can add a member by email", async ({ userPage: page, baseURL }) => {
    // Create a fresh user with a unique email so this test never clashes with seed data
    const { token: adminToken } = await getAdminAuth(baseURL);
    const freshEmail = `member-add-${uid("")}@test.local`;
    await createUser(adminToken, { email: freshEmail }, baseURL);

    await page.goto(MEMBERS_URL);
    // Fresh user is not yet in hust-cs; add them via the UI
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    await page.getByRole("dialog").getByLabel("Email").fill(freshEmail);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(freshEmail)).toBeVisible();

    // Cleanup: remove the fresh member so subsequent runs are clean
    try {
      const freshRow = page.getByRole("row").filter({ hasText: freshEmail });
      await openMemberActions(page, freshRow);
      await page.getByRole("menuitem", { name: "Xóa khỏi tổ chức" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
      await expect(freshRow).not.toBeVisible();
    } catch {
      // Best-effort cleanup; test already passed
    }
  });

  test("admin can change a member role", async ({ userPage: page, baseURL }) => {
    // Create a fresh user and add them to hust-cs as teacher via API
    const { token: adminToken } = await getAdminAuth(baseURL);
    const freshEmail = `member-role-${uid("")}@test.local`;
    const freshUserId = await createUser(adminToken, { email: freshEmail }, baseURL);
    const orgId = await getOrgId(adminToken, ORG_SLUG, baseURL);
    await addOrgMember(adminToken, orgId, freshUserId, OrganizationRole.TEACHER, baseURL);

    await page.goto(`${MEMBERS_URL}?q=${encodeURIComponent(freshEmail)}`);
    // Find fresh user row (search by unique email avoids pagination issues)
    const freshRow = page.getByRole("row").filter({ hasText: freshEmail });
    await expect(freshRow).toBeVisible();

    // Change role: teacher → student
    await openMemberActions(page, freshRow);
    await page.getByRole("menuitem", { name: "Đổi vai trò" }).hover();
    await page.getByRole("menuitem", { name: "Học viên" }).click();
    await expect(freshRow.getByText("Học viên")).toBeVisible();

    // Change role back: student → teacher
    await openMemberActions(page, freshRow);
    await page.getByRole("menuitem", { name: "Đổi vai trò" }).hover();
    await page.getByRole("menuitem", { name: "Giảng viên" }).click();
    await expect(freshRow.getByText("Giảng viên")).toBeVisible();

    // Cleanup: remove the fresh member
    try {
      await openMemberActions(page, freshRow);
      await page.getByRole("menuitem", { name: "Xóa khỏi tổ chức" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
      await expect(freshRow).not.toBeVisible();
    } catch {
      // Best-effort cleanup; test already passed
    }
  });
});
