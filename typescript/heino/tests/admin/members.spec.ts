import { test, expect, uid } from "../fixtures";
import type { Locator, Page } from "@playwright/test";

const SEED_ORG_SLUG = process.env.TEST_ORG_SLUG ?? "dyadia-demo";
const MEMBERS_URL = `/admin/organizations/${SEED_ORG_SLUG}/members`;
const CREATE_USER_BUTTON = "Tạo người dùng";

function uniqueEmail() {
  return `e2e.member.${uid("")}@test.local`;
}

async function gotoMembers(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded" });
      return;
    } catch (err) {
      if (err instanceof Error && err.message.includes("NS_BINDING_ABORTED") && attempt < 2) {
        continue;
      }
      throw err;
    }
  }
}

// Create a user and return their UUID by reading the detail-link href (avoids click-navigation flakiness).
async function createUserAndGetId(page: Page, email: string): Promise<string> {
  await page.goto("/admin/users");
  await page.getByRole("button", { name: CREATE_USER_BUTTON }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Họ").fill("E2E");
  await dialog.getByLabel("Tên").fill("Member");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Mật khẩu").fill("TestPass123!");
  await dialog.getByRole("button", { name: "Tạo" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await page.goto(`/admin/users?q=${encodeURIComponent(email)}`);
  const row = page.getByRole("row").filter({ hasText: email });
  await row.getByRole("button").click();
  const link = page.getByRole("menuitem", { name: "Xem chi tiết" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  await page.keyboard.press("Escape");
  return href.split("/").at(-1)!;
}

async function openMemberActions(page: Page, memberRow: Locator) {
  const actionsButton = memberRow.getByRole("button", { name: "Mở menu thao tác thành viên" });
  await expect(actionsButton).toBeVisible();
  await actionsButton.click();
  await expect(page.getByRole("menuitem", { name: "Đổi vai trò" })).toBeVisible();
}

test.describe("Members list page", () => {
  test("renders heading and table columns", async ({ adminPage: page }) => {
    await gotoMembers(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Thành viên");
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Người dùng" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Ngày thêm" })).toBeVisible();
  });

  test("shows seeded members", async ({ adminPage: page }) => {
    await gotoMembers(page);
    // Table should have at least one data row (seeded members exist)
    const rows = page.getByRole("row");
    expect(await rows.count()).toBeGreaterThan(1); // more than just the header
  });

  test("opens add-member dialog", async ({ adminPage: page }) => {
    await gotoMembers(page);
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Thêm thành viên" })).toBeVisible();
  });

  test("dialog has Email field and role select", async ({ adminPage: page }) => {
    await gotoMembers(page);
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Email")).toBeVisible();
    await expect(dialog.locator("[data-slot='select-trigger']")).toBeVisible();
  });

  test("closes dialog on Hủy", async ({ adminPage: page }) => {
    await gotoMembers(page);
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("empty email submit keeps dialog open", async ({ adminPage: page }) => {
    await gotoMembers(page);
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

test.describe("Member management", () => {
  let memberEmail: string;

  test.beforeEach(async ({ adminPage: page }) => {
    memberEmail = uniqueEmail();
    await createUserAndGetId(page, memberEmail);

    // Add the user as a member of the seed org
    await gotoMembers(page);
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email").fill(memberEmail);
    // default role is Học viên
    await dialog.getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: memberEmail })).toBeVisible();
  });

  test("added member appears in the table", async ({ adminPage: page }) => {
    await gotoMembers(page);
    const memberRow = page.getByRole("row").filter({ hasText: memberEmail });
    await expect(memberRow).toBeVisible();
    await expect(memberRow.getByText("Học viên")).toBeVisible();
  });

  test("updates member role", async ({ adminPage: page }) => {
    await gotoMembers(page);
    const memberRow = page.getByRole("row").filter({ hasText: memberEmail });
    await openMemberActions(page, memberRow);
    await page.getByRole("menuitem", { name: "Đổi vai trò" }).hover();
    await page.getByRole("menuitem", { name: "Giảng viên" }).click();
    await expect(memberRow.getByText("Giảng viên")).toBeVisible();
  });

  test("updates member status", async ({ adminPage: page }) => {
    await gotoMembers(page);
    const memberRow = page.getByRole("row").filter({ hasText: memberEmail });
    await openMemberActions(page, memberRow);
    await page.getByRole("menuitem", { name: "Đổi trạng thái" }).hover();
    await page.getByRole("menuitem", { name: "Tạm khóa" }).click();
    await expect(memberRow.getByText("Tạm khóa")).toBeVisible();
  });

  test("removes member via confirm dialog", async ({ adminPage: page }) => {
    await gotoMembers(page);
    const memberRow = page.getByRole("row").filter({ hasText: memberEmail });
    await openMemberActions(page, memberRow);
    await page.getByRole("menuitem", { name: "Xóa khỏi tổ chức" }).click();

    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByRole("alertdialog").getByText("Xóa thành viên?")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();

    await expect(page.getByRole("row").filter({ hasText: memberEmail })).not.toBeVisible();
  });
});
