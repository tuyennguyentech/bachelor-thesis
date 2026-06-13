/**
 * E2E — Course role feature: the manager "learn mode" toggle (?mode=learn) and
 * the org-teacher request-to-manage lock screen.
 *
 * Seed anchors (hust-cs):
 *   carol (teacherPage) = org TEACHER, OWNER + manager of the DSA course, and a
 *     NON-member of every other hust-cs course → locked there.
 *
 * ?mode=learn turns a manager into a REAL, persisted student (StudentLessonView,
 * attempts saved) — distinct from ?preview=1 (a non-persisted Studio peek).
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
  SEED_DSA_LESSON_BIG_O,
  goToSeededLesson,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;
const OTHER_HUST_CS_COURSE = "Hệ điều hành";

async function goToDsaCourse(page: import("@playwright/test").Page): Promise<string> {
  await page.goto(`${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, {
    waitUntil: "domcontentloaded",
  });
  const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
  const href = await card.getByRole("link").last().getAttribute("href");
  if (!href) throw new Error(`DSA course card not found`);
  const base = href.split("?")[0].replace(/\/$/, "");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  return base;
}

// ── Course-page mode toggle ──────────────────────────────────────────────────

test.describe("Course learn-mode toggle (manager)", () => {
  test("manager sees the Vào học | Quản lý toggle; manage is active by default", async ({ teacherPage: page }) => {
    await goToDsaCourse(page);
    await expect(page.getByTestId("manage-toggle")).toBeVisible();
    await expect(page.getByTestId("learn-toggle")).toBeVisible();
    // No mode param → manage mode → the manage pill is the active one.
    await expect(page.getByTestId("manage-toggle")).toHaveAttribute("data-active", "true");
  });

  test("course owner (already a member) sees the 'Vào lại học' re-entry link", async ({ teacherPage: page }) => {
    await goToDsaCourse(page);
    // carol owns DSA and therefore has a membership row → re-entry, not first-entry.
    await expect(page.getByTestId("learn-toggle")).toContainText("Vào lại học");
  });

  test("entering ?mode=learn shows the learn banner and activates the learn pill", async ({ teacherPage: page }) => {
    const base = await goToDsaCourse(page);
    await page.goto(`${base}?mode=learn`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/Bạn đang ở chế độ học/)).toBeVisible();
    await expect(page.getByTestId("learn-toggle")).toHaveAttribute("data-active", "true");
  });
});

// ── Lesson page in learn mode: real student view, not the Studio ─────────────

test.describe("Lesson learn-mode (manager learns as a real student)", () => {
  test("lesson in ?mode=learn shows the learn banner and a 'Quay lại Studio' escape", async ({ teacherPage: page }) => {
    const href = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${href}?mode=learn`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("lesson-learn-banner")).toBeVisible();
    await expect(page.getByRole("link", { name: /Quay lại Studio/ })).toBeVisible();
  });
});

// ── Request-to-manage: org teacher locked out of a non-member course ─────────

test.describe("Request-to-manage (org teacher, non-member course)", () => {
  test("org teacher sees the locked course and a role selector on its lock screen", async ({ teacherPage: page }) => {
    // carol is an org TEACHER in hust-cs but belongs only to the DSA course, so
    // another hust-cs course is locked for her (FE canManage is membership-based,
    // matching the backend — an org-teacher does NOT bypass).
    await page.goto(`${COURSES_URL}?q=${encodeURIComponent(OTHER_HUST_CS_COURSE)}`, {
      waitUntil: "domcontentloaded",
    });
    const requestLink = page.getByTestId("card-request-join").first();
    await expect(requestLink).toBeVisible();
    const href = await requestLink.getAttribute("href");
    if (!href) throw new Error("Locked course request link not found");

    await page.goto(href, { waitUntil: "domcontentloaded" });
    // Lock screen with the role selector (org teacher may request the manager role).
    await expect(page.getByText("Khóa học đang bị khóa")).toBeVisible();
    await expect(page.getByTestId("request-role-select")).toBeVisible();
  });
});
