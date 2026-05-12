import { test as base, expect, type Page } from "@playwright/test";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@dyadia.local";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "changeme123";
export const USER_EMAIL = process.env.USER_EMAIL ?? "alice@dyadia.local";
export const USER_PASSWORD = process.env.USER_PASSWORD ?? "Password123!";
export const SEED_ORG_SLUG = process.env.TEST_ORG_SLUG ?? "dyadia-demo";
// carol is teacher in hust-cs; bob is student in hust-cs
export const TEACHER_EMAIL = "carol@dyadia.local";
export const STUDENT_EMAIL = "bob@dyadia.local";

async function loginAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL(/\/(admin|dashboard)/);
}

export const test = base.extend<{
  adminPage: Page;
  userPage: Page;
  teacherPage: Page;
  studentPage: Page;
}>({
  adminPage: async ({ page }, use) => {
    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await use(page);
  },
  userPage: async ({ page }, use) => {
    await loginAs(page, USER_EMAIL, USER_PASSWORD);
    await use(page);
  },
  teacherPage: async ({ page }, use) => {
    await loginAs(page, TEACHER_EMAIL, USER_PASSWORD);
    await use(page);
  },
  studentPage: async ({ page }, use) => {
    await loginAs(page, STUDENT_EMAIL, USER_PASSWORD);
    await use(page);
  },
});

export { expect };
