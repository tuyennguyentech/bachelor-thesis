import { test as base, expect, type Page } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@dyadia.local";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "changeme123";
export const USER_EMAIL = process.env.USER_EMAIL ?? "alice@dyadia.local";
export const USER_PASSWORD = process.env.USER_PASSWORD ?? "Password123!";
export const SEED_ORG_SLUG = process.env.TEST_ORG_SLUG ?? "dyadia-demo";
// carol is teacher in hust-cs; bob is student in hust-cs
export const TEACHER_EMAIL = "carol@dyadia.local";
export const STUDENT_EMAIL = "bob@dyadia.local";

const authTransports = new Map<string, ReturnType<typeof createConnectTransport>>();

function getAuthTransport(baseURL: string) {
  const rpcBaseUrl = process.env.RICHTER_BASE_URL ?? `${baseURL}/api/richter`;
  let transport = authTransports.get(rpcBaseUrl);
  if (!transport) {
    transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl });
    authTransports.set(rpcBaseUrl, transport);
  }
  return transport;
}

export async function loginAs(page: Page, email: string, password: string, baseURL = "http://caddy") {
  const client = createClient(AuthService, getAuthTransport(baseURL));
  const res = await client.login({ email, password });
  const secure = baseURL.startsWith("https://");

  await page.context().addCookies([
    {
      name: "dyadia_access",
      value: res.accessToken,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
      secure,
    },
    {
      name: "dyadia_refresh",
      value: res.refreshToken,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
      secure,
    },
  ]);
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
  adminPage: async ({ page, baseURL }, use) => {
    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD, baseURL);
    await use(page);
  },
  userPage: async ({ page, baseURL }, use) => {
    await loginAs(page, USER_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
  teacherPage: async ({ page, baseURL }, use) => {
    await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
  studentPage: async ({ page, baseURL }, use) => {
    await loginAs(page, STUDENT_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
});
/* eslint-enable react-hooks/rules-of-hooks */

// ── Seeded data helpers ──────────────────────────────────────────────────────

export const SEED_HUST_CS_SLUG = "hust-cs";
export const SEED_DSA_COURSE_TITLE = "Cấu trúc dữ liệu và Giải thuật";
export const SEED_DSA_LESSON_BIG_O = "Bài 1: Big-O, Omega, Theta notation";
export const SEED_DSA_LESSON_RECURRENCE = "Bài 2: Phân tích đệ quy với Master Theorem";

async function isOnSeededLesson(page: Page, lessonTitle: string) {
  return page.url().includes("/lessons/") && (await page.getByRole("heading", { name: lessonTitle }).isVisible().catch(() => false));
}

/**
 * Navigate to a lesson inside the seeded DSA course (in hust-cs org) using ?q= search.
 * Returns the lesson URL — earlier "iterate through 30 pages" variants were flaky when
 * seed data shifted; the search query is canonical because course titles are unique.
 */
export async function goToSeededLesson(page: Page, lessonTitle: string): Promise<string> {
  if (await isOnSeededLesson(page, lessonTitle)) {
    return page.url();
  }

  const coursesUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;
  try {
    await page.goto(`${coursesUrl}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, { waitUntil: "domcontentloaded" });
  } catch (err) {
    if (!(await isOnSeededLesson(page, lessonTitle))) {
      throw err;
    }
    return page.url();
  }

  const row = page.getByRole("row").filter({ hasText: SEED_DSA_COURSE_TITLE });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Seeded course "${SEED_DSA_COURSE_TITLE}" not found`);
  await page.goto(courseHref, { waitUntil: "domcontentloaded" });
  const lessonLink = page.getByRole("link").filter({ hasText: lessonTitle }).first();
  const lessonHref = await lessonLink.getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson link not found for "${lessonTitle}"`);
  await page.goto(lessonHref, { waitUntil: "domcontentloaded" });
  return lessonHref;
}

export { expect };
export type { Page };
