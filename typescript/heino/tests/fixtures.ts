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

/* eslint-disable react-hooks/rules-of-hooks --
 * `use` is Playwright's fixture-injection callback, not the React `use` hook.
 * ESLint's rules-of-hooks rule misidentifies it because of the name collision.
 */
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
/* eslint-enable react-hooks/rules-of-hooks */

// ── Seeded data helpers ──────────────────────────────────────────────────────

export const SEED_HUST_CS_SLUG = "hust-cs";
export const SEED_DSA_COURSE_TITLE = "Cấu trúc dữ liệu và Giải thuật";
export const SEED_DSA_LESSON_BIG_O = "Bài 1: Big-O, Omega, Theta notation";
export const SEED_DSA_LESSON_RECURRENCE = "Bài 2: Phân tích đệ quy với Master Theorem";

/**
 * Navigate to a lesson inside the seeded DSA course (in hust-cs org) using ?q= search.
 * Returns the lesson URL — earlier "iterate through 30 pages" variants were flaky when
 * seed data shifted; the search query is canonical because course titles are unique.
 */
export async function goToSeededLesson(page: Page, lessonTitle: string): Promise<string> {
  const coursesUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;
  await page.goto(`${coursesUrl}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`);
  const row = page.getByRole("row").filter({ hasText: SEED_DSA_COURSE_TITLE });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Seeded course "${SEED_DSA_COURSE_TITLE}" not found`);
  await page.goto(courseHref);
  const lessonLink = page.getByRole("link").filter({ hasText: lessonTitle }).first();
  const lessonHref = await lessonLink.getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson link not found for "${lessonTitle}"`);
  await page.goto(lessonHref);
  return lessonHref;
}

export { expect };
