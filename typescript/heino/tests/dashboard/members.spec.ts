/**
 * E2E tests for dashboard org member management.
 *
 * hust-cs seed roles:
 *   alice  = admin  (userPage)  — canManage
 *   carol  = teacher (teacherPage) — cannot manage members
 *   bob    = student (studentPage) — cannot manage members
 */

import { test, expect } from "../fixtures";

const ORG_SLUG = "hust-cs";
const MEMBERS_URL = `/dashboard/organizations/${ORG_SLUG}/members`;

test.describe("Dashboard members page visibility", () => {
  test("shows Xem thành viên link on org detail page", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${ORG_SLUG}`);
    await expect(page.getByRole("link", { name: "Xem thành viên" })).toBeVisible();
  });

  test("link navigates to members page", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${ORG_SLUG}`);
    await page.getByRole("link", { name: "Xem thành viên" }).click();
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
    await page.goto(MEMBERS_URL);
    // alice (admin) is a seeded member — full name "Alice Nguyen" and email should appear
    // scope to table to avoid strict-mode collision with header "Xin chào, Alice Nguyen"
    await expect(page.getByRole("table").getByText("Alice Nguyen")).toBeVisible();
    await expect(page.getByText("alice@dyadia.local")).toBeVisible();
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
  // Use a seeded user not yet in a specific org for add-member test.
  // grace@dyadia.local is a student in hust-cs — already there.
  // quinn@dyadia.local is NOT in hust-cs — use for add test.
  const NEW_MEMBER_EMAIL = "quinn@dyadia.local";

  test("admin can add a member by email", async ({ userPage: page }) => {
    await page.goto(MEMBERS_URL);
    // Remove quinn if already present from a previous run (idempotent)
    const quinnRow = page.getByRole("row").filter({ hasText: NEW_MEMBER_EMAIL });
    if (await quinnRow.isVisible()) {
      await quinnRow.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Xóa khỏi org" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
      await expect(quinnRow).not.toBeVisible();
    }
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    await page.getByRole("dialog").getByLabel("Email").fill(NEW_MEMBER_EMAIL);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(NEW_MEMBER_EMAIL)).toBeVisible();
  });

  test("admin can change a member role", async ({ userPage: page }) => {
    await page.goto(MEMBERS_URL);
    // find carol (teacher) row and change her role to student
    const carolRow = page.getByRole("row").filter({ hasText: "carol@dyadia.local" });
    await carolRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Đổi role" }).hover();
    await page.getByRole("menuitem", { name: "Học viên" }).click();
    await expect(carolRow.getByText("Học viên")).toBeVisible();
    // restore back to teacher
    await carolRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Đổi role" }).hover();
    await page.getByRole("menuitem", { name: "Giảng viên" }).click();
    await expect(carolRow.getByText("Giảng viên")).toBeVisible();
  });
});
