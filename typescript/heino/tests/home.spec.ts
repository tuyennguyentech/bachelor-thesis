import { test, expect, ADMIN_EMAIL } from "./fixtures";
import { test as base } from "@playwright/test";

base.describe("Home page (unauthenticated)", () => {
  base("shows landing content and CTAs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Both header and hero have login/register links; first() picks the header one
    await expect(page.getByRole("link", { name: "Đăng nhập" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Đăng ký" }).first()).toBeVisible();
  });

  base("shows three feature cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Video bài giảng tương tác")).toBeVisible();
    await expect(page.getByText("Câu hỏi tự động từ AI")).toBeVisible();
    await expect(page.getByText("Theo dõi tiến trình học tập")).toBeVisible();
  });

  base("login CTA navigates to /login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Đăng nhập" }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  base("register CTA navigates to /register", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Đăng ký" }).first().click();
    await expect(page).toHaveURL(/\/register/);
  });
});

test.describe("Home page (authenticated)", () => {
  test("admin is redirected to /admin/users", async ({ adminPage: page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/admin\/users/);
  });

  test("normal user is redirected to /dashboard", async ({ userPage: page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

base.describe("Register page", () => {
  base("shows form fields", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Đăng ký" })).toBeVisible();
    await expect(page.getByLabel("Họ")).toBeVisible();
    // "Tên đệm" contains "Tên" — use exact to avoid strict mode
    await expect(page.getByLabel("Tên", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Mật khẩu")).toBeVisible();
  });

  base("has link back to login", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("link", { name: "Đăng nhập" })).toBeVisible();
  });

  base("short password blocked by browser (minLength)", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Họ").fill("Test");
    await page.getByLabel("Tên", { exact: true }).fill("User");
    await page.getByLabel("Email").fill("short@test.local");
    await page.getByLabel("Mật khẩu").fill("short");
    await page.getByRole("button", { name: "Đăng ký" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });

  base("registers a new account and redirects to login", async ({ page }) => {
    const email = `e2e.register.${Date.now()}@test.local`;
    await page.goto("/register");
    await page.getByLabel("Họ").fill("Reg");
    await page.getByLabel("Tên", { exact: true }).fill("User");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mật khẩu").fill("Register123!");
    await page.getByRole("button", { name: "Đăng ký" }).click();
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });

  base("shows error for duplicate email", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Họ").fill("Dup");
    await page.getByLabel("Tên", { exact: true }).fill("Email");
    // Use an email that already exists (admin)
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Mật khẩu").fill("Register123!");
    await page.getByRole("button", { name: "Đăng ký" }).click();
    await expect(page.locator("div[class*='bg-destructive']")).toBeVisible();
  });
});

base.describe("Unauthorized page", () => {
  base("shows 403 message", async ({ page }) => {
    await page.goto("/unauthorized");
    await expect(page.getByRole("heading")).toBeVisible();
  });
});
