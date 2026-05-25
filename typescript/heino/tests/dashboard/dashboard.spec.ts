import { test, expect } from "../fixtures";

test.describe("Dashboard home", () => {
  test("shows personalized greeting", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Xin chào");
  });

  test("shows primary actions for organization and profile", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Tạo tổ chức" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Hồ sơ" }).first()).toBeVisible();
  });

  test("shows recent access section", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Truy cập gần đây" })).toBeVisible();
  });

  test("org list action navigates to /dashboard/organizations", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Tất cả tổ chức" }).click();
    await expect(page).toHaveURL(/\/dashboard\/organizations/);
  });

  test("profile action navigates to /dashboard/profile", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Hồ sơ" }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/profile/);
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout redirects to /login", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Đăng xuất" }).click();
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Dashboard sidebar navigation", () => {
  test("sidebar has Tổ chức and Hồ sơ links", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Tổ chức" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Hồ sơ" })).toBeVisible();
  });
});
