import { test, expect, USER_EMAIL } from "../fixtures";

test.describe("Dashboard home", () => {
  test("shows personalized greeting", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Xin chào");
  });

  test("shows quick-links to org list and profile", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Tổ chức của tôi" })).toBeVisible();
    // "Cập nhật thông tin" is unique to the profile card (sidebar shows "Hồ sơ")
    await expect(page.getByText("Cập nhật thông tin")).toBeVisible();
  });

  test("shows recent organizations section", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Tổ chức gần đây")).toBeVisible();
  });

  test("org list quick-link navigates to /dashboard/organizations", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Tổ chức của tôi" }).click();
    await expect(page).toHaveURL(/\/dashboard\/organizations/);
  });

  test("profile quick-link navigates to /dashboard/profile", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByText("Cập nhật thông tin").click();
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
    await expect(page.getByRole("navigation")).toBeVisible();
  });
});
