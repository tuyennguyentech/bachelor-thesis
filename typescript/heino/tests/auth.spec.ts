import { test, expect, ADMIN_EMAIL, ADMIN_PASSWORD } from "./fixtures";
import { test as base } from "@playwright/test";

base.describe("Authentication", () => {
  base.describe("Login", () => {
    base("shows form fields", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByLabel("Email")).toBeVisible();
      await expect(page.getByLabel("Mật khẩu")).toBeVisible();
      await expect(page.getByRole("button", { name: "Đăng nhập" })).toBeVisible();
    });

    base("shows registered banner with ?registered param", async ({ page }) => {
      await page.goto("/login?registered=1");
      await expect(page.getByText("Đăng ký thành công")).toBeVisible();
    });

    base("redirects unauthenticated users to /login", async ({ page }) => {
      await page.goto("/admin");
      await expect(page).toHaveURL(/\/login/);
    });

    base("shows validation error for wrong password", async ({ page }) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(ADMIN_EMAIL);
      await page.getByLabel("Mật khẩu").fill("wrongpassword");
      await page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(page.locator("div[class*='bg-destructive']")).toBeVisible();
    });

    base("logs in successfully and redirects to admin", async ({ page }) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(ADMIN_EMAIL);
      await page.getByLabel("Mật khẩu").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Đăng nhập" }).click();
      await page.waitForURL(/\/(admin|dashboard)/);
      await expect(page).not.toHaveURL(/\/login/);
    });

    base("redirects to ?next page after successful login", async ({ page }) => {
      await page.goto("/admin/users");
      // proxy redirects unauthenticated to /login?next=...
      await expect(page).toHaveURL(/\/login/);
      await page.getByLabel("Email").fill(ADMIN_EMAIL);
      await page.getByLabel("Mật khẩu").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Đăng nhập" }).click();
      await page.waitForURL(/\/admin\/users/);
      await expect(page).toHaveURL(/\/admin\/users/);
    });
  });
});

test.describe("Access control", () => {
  test("normal user accessing /admin is redirected to /unauthorized", async ({ userPage: page }) => {
    await page.goto("/admin/organizations");
    await expect(page).toHaveURL(/\/unauthorized/);
  });
});

test.describe("Logout", () => {
  test("admin can log out and is redirected to login", async ({ adminPage: page }) => {
    await page.goto("/admin");
    // Wait for the logout control to mount/hydrate before clicking (a click during
    // the hydration window is a no-op), then give the cookie-clear + middleware
    // redirect a generous budget — both flake under full-suite parallel load.
    const logout = page.getByRole("button", { name: "Đăng xuất" });
    await expect(logout).toBeVisible({ timeout: 10000 });
    await logout.click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("after logout, protected pages redirect to login", async ({ adminPage: page }) => {
    await page.goto("/admin");
    // Ensure the logout control is mounted/hydrated before clicking, then give
    // the cookie-clear + middleware redirect generous time (flaked under load).
    const logout = page.getByRole("button", { name: "Đăng xuất" });
    await expect(logout).toBeVisible({ timeout: 10000 });
    await logout.click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    await page.goto("/admin/organizations");
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
