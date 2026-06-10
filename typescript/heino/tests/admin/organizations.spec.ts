import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

const SEED_ORG_SLUG = process.env.TEST_ORG_SLUG ?? "dyadia-demo";
const ORGS_URL = "/admin/organizations";
const CREATE_ORG_BUTTON = "Tạo tổ chức";
const OWNER_LABEL = "Người sở hữu ban đầu";

function uniqueSlug() {
  return `e2e-${Date.now()}`;
}

function uniqueName() {
  return `E2E Org ${Date.now()}`;
}

// Get any seeded user's UUID by reading the detail-link href (avoids click-navigation flakiness).
async function getAnyUserId(page: Page): Promise<string> {
  await page.goto("/admin/users");
  const firstDataRow = page.getByRole("row").nth(1);
  await firstDataRow.getByRole("button").click();
  const link = page.getByRole("menuitem", { name: "Xem chi tiết" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  await page.keyboard.press("Escape");
  return href.split("/").at(-1)!;
}

test.describe("Org list page", () => {
  test("renders table with heading and create button", async ({ adminPage: page }) => {
    await page.goto(ORGS_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Tổ chức", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: CREATE_ORG_BUTTON })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Slug" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
  });

  test("shows seeded organizations", async ({ adminPage: page }) => {
    await page.goto(`${ORGS_URL}?q=${SEED_ORG_SLUG}`);
    await expect(page.getByRole("cell", { name: SEED_ORG_SLUG, exact: true })).toBeVisible();
  });

  test("opens create-org dialog", async ({ adminPage: page }) => {
    await page.goto(ORGS_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Tổ chức", level: 1 })).toBeVisible();
    const btn = page.getByRole("button", { name: CREATE_ORG_BUTTON });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Tạo tổ chức mới" })).toBeVisible();
  });

  test("dialog has Tên, Slug, Owner fields", async ({ adminPage: page }) => {
    await page.goto(ORGS_URL);
    await page.getByRole("button", { name: CREATE_ORG_BUTTON }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Tên")).toBeVisible();
    await expect(dialog.getByLabel("Slug")).toBeVisible();
    await expect(dialog.getByLabel(OWNER_LABEL)).toBeVisible();
  });

  test("closes dialog on Hủy", async ({ adminPage: page }) => {
    await page.goto(ORGS_URL);
    await page.getByRole("button", { name: CREATE_ORG_BUTTON }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("empty submit keeps dialog open (required fields)", async ({ adminPage: page }) => {
    await page.goto(ORGS_URL);
    await page.getByRole("button", { name: CREATE_ORG_BUTTON }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("creates a new org and shows it in the table", async ({ adminPage: page }) => {
    const userId = await getAnyUserId(page);
    const slug = uniqueSlug();
    const name = uniqueName();

    await page.goto(ORGS_URL);
    await page.getByRole("button", { name: CREATE_ORG_BUTTON }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Tên").fill(name);
    await dialog.getByLabel("Slug").fill(slug);
    await dialog.getByLabel(OWNER_LABEL).fill(userId);
    await dialog.getByRole("button", { name: "Tạo" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("cell", { name: slug, exact: true })).toBeVisible();
  });

  test("search filters organizations by slug", async ({ adminPage: page }) => {
    await page.goto(ORGS_URL);
    const searchInput = page.getByPlaceholder("ID hoặc slug…");
    await searchInput.fill(SEED_ORG_SLUG);
    await page.waitForURL(new RegExp(`q=${SEED_ORG_SLUG}`));
    await expect(page.getByRole("cell", { name: SEED_ORG_SLUG, exact: true })).toBeVisible();
  });
});

test.describe("Org detail page", () => {
  test("shows heading, slug, and navigation buttons", async ({ adminPage: page }) => {
    await page.goto(`/admin/organizations/${SEED_ORG_SLUG}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Thành viên" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Khóa học" })).toBeVisible();
  });

  test("shows all sections", async ({ adminPage: page }) => {
    await page.goto(`/admin/organizations/${SEED_ORG_SLUG}`);
    await expect(page.getByText("Thông tin chung")).toBeVisible();
    await expect(page.getByText("Trạng thái")).toBeVisible();
    await expect(page.getByText("Xóa tổ chức")).toBeVisible();
  });

  test("Thành viên link navigates to members page", async ({ adminPage: page }) => {
    await page.goto(`/admin/organizations/${SEED_ORG_SLUG}`);
    await page.getByRole("link", { name: "Thành viên" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/organizations/${SEED_ORG_SLUG}/members`));
  });

  test("Khóa học link navigates to courses page", async ({ adminPage: page }) => {
    await page.goto(`/admin/organizations/${SEED_ORG_SLUG}`);
    await page.getByRole("link", { name: "Khóa học" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/organizations/${SEED_ORG_SLUG}/courses`));
  });
});

test.describe("Org detail CRUD", () => {
  let orgSlug: string;
  let orgUrl: string;

  test.beforeEach(async ({ adminPage: page }) => {
    const userId = await getAnyUserId(page);
    orgSlug = uniqueSlug();
    const orgName = uniqueName();

    await page.goto(ORGS_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Tổ chức", level: 1 })).toBeVisible({ timeout: 10_000 });
    const createBtn = page.getByRole("button", { name: CREATE_ORG_BUTTON });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel("Tên").fill(orgName);
    await dialog.getByLabel("Slug").fill(orgSlug);
    await dialog.getByLabel(OWNER_LABEL).fill(userId);
    await dialog.getByRole("button", { name: "Tạo" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    await page.goto(`/admin/organizations/${orgSlug}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    orgUrl = page.url();
  });

  test("edits org name", async ({ adminPage: page }) => {
    await page.goto(orgUrl);
    const newName = `Renamed ${Date.now()}`;
    await page.getByLabel("Tên").clear();
    await page.getByLabel("Tên").fill(newName);
    await page.getByRole("button", { name: "Lưu" }).click();
    // Next.js revalidates the route in-place after the action — heading updates without navigation
    await expect(page.getByRole("heading", { name: newName, level: 1 })).toBeVisible();
  });

  test("updates org status", async ({ adminPage: page }) => {
    await page.goto(orgUrl);
    const statusTrigger = page.locator("[data-slot='select-trigger']");
    await statusTrigger.click();
    await page.getByRole("option", { name: "Tạm khóa" }).click();
    await expect(statusTrigger).toContainText("Tạm khóa");
  });

  test("deletes org and redirects to list", async ({ adminPage: page }) => {
    await page.goto(orgUrl);
    await page.getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await page.waitForURL(/\/admin\/organizations$/);
    await expect(page).toHaveURL(/\/admin\/organizations$/);
  });
});
