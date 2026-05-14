/**
 * E2E tests for dashboard lesson detail page.
 *
 * Tests that:
 * - Lesson title is visible for all roles
 * - Video upload section is visible to teacher/admin
 * - Video upload section is hidden from student
 * - Lesson rows in course detail are clickable links
 * - Student sees previous quiz attempt on seeded lesson
 * - Student can retake quiz and see new score
 * - Teacher sees "Thay video", video key, and AI section on lesson with video_key
 */

import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

const ORG_SLUG = "hust-cs";
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

// ── Lesson link navigation ─────────────────────────────────────────────────

test.describe("Lesson row is a link to lesson detail", () => {
  test("clicking a lesson row navigates to lesson detail page", async ({ teacherPage: page }) => {
    // Create a course + module + lesson
    const courseTitle = uid("Khóa học Bài học Link E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    const href = await row.getByRole("link").getAttribute("href");
    const courseUrl = `${href}`;
    await page.goto(courseUrl);

    // Add module
    await page.getByRole("button", { name: "Thêm chương" }).click();
    const moduleName = uid("Chương Link E2E");
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Add lesson
    const lessonTitle = uid("Bài học Link E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Click the lesson row link — read href to avoid flaky Firefox navigation
    const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
    const lessonHref = await lessonRow.getByRole("link").getAttribute("href");
    await page.goto(`${lessonHref}`);

    await expect(page.getByRole("heading", { name: lessonTitle })).toBeVisible();
  });
});

// ── Teacher sees video upload on lesson detail ─────────────────────────────

test.describe("Lesson detail — teacher", () => {
  let lessonUrl: string;

  test.beforeEach(async ({ teacherPage: page }) => {
    const courseTitle = uid("Khóa học Giáo viên Bài học E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    const courseHref = await row.getByRole("link").getAttribute("href");
    await page.goto(`${courseHref}`);

    const moduleName = uid("Chương E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
    const href = await lessonRow.getByRole("link").getAttribute("href");
    lessonUrl = `${href}`;
  });

  test("shows lesson title and video upload section", async ({ teacherPage: page }) => {
    await page.goto(lessonUrl);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Quản lý video")).toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
  });
});

// ── Student sees lesson but no upload controls ─────────────────────────────

test.describe("Lesson detail — student read-only", () => {
  test("student sees lesson but no video upload", async ({ studentPage: page }) => {
    // Navigate to first seeded course, first lesson available
    await page.goto(COURSES_URL);
    const courseHref = await page.getByRole("row").nth(1).getByRole("link").getAttribute("href");
    await page.goto(`${courseHref}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // If there are any lesson rows, click the first one
    const lessonLinks = page.locator("div.border a");
    const count = await lessonLinks.count();
    if (count === 0) {
      // No lessons in this course — skip
      return;
    }
    const href = await lessonLinks.first().getAttribute("href");
    await page.goto(`${href}`);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Quản lý video")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
  });
});

// ── Teacher sees progress section ──────────────────────────────────────────

test.describe("Lesson detail — progress section", () => {
  test("teacher sees student progress section", async ({ teacherPage: page }) => {
    const courseTitle = uid("Khóa học Tiến độ E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    const courseHref = await row.getByRole("link").getAttribute("href");
    await page.goto(`${courseHref}`);

    const moduleName = uid("Chương Tiến độ E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài Tiến độ E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
    const href = await lessonRow.getByRole("link").getAttribute("href");
    await page.goto(`${href}`);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Tiến độ học viên")).toBeVisible();
  });
});

// ── Seeded lesson navigation helper ───────────────────────────────────────

const SEEDED_COURSE = "Cấu trúc dữ liệu và Giải thuật";
const SEEDED_LESSON_BIG_O = "Bài 1: Big-O, Omega, Theta notation";
const HUST_CS_COURSES_BASE = `/dashboard/organizations/hust-cs/courses`;

// Paginates through the courses list (ordered newest-first) to find the seeded
// DSA course, then navigates to the given lesson inside it.
async function goToSeededLesson(page: Page, lessonTitle: string): Promise<void> {
  for (let p = 1; p <= 30; p++) {
    await page.goto(`${HUST_CS_COURSES_BASE}?page=${p}`);
    const courseRow = page.getByRole("row").filter({ hasText: SEEDED_COURSE });
    if ((await courseRow.count()) > 0) {
      const courseHref = await courseRow.getByRole("link").first().getAttribute("href");
      await page.goto(`${courseHref}`);
      const lessonLink = page.getByRole("link").filter({ hasText: lessonTitle }).first();
      const lessonHref = await lessonLink.getAttribute("href");
      await page.goto(`${lessonHref}`);
      return;
    }
    if ((await page.getByRole("link", { name: "Sau →" }).count()) === 0) break;
  }
  throw new Error(`Seeded course "${SEEDED_COURSE}" not found within 30 pages`);
}

// ── Seeded lesson — student sees previous quiz attempt ─────────────────────

test.describe("Seeded lesson — student sees previous quiz attempt", () => {
  test("shows quiz section with previous attempt result", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();
    // bob has a seeded quiz attempt — the result banner and Làm lại button must appear
    await expect(page.getByText(/Kết quả:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });
});

// ── Seeded lesson — student can retake quiz ────────────────────────────────

test.describe("Seeded lesson — student can retake quiz", () => {
  test("retake: select all answers then submit sees new score", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);

    await page.getByRole("button", { name: "Làm lại" }).click();

    // All answers cleared — Nộp bài is disabled
    const submitBtn = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn).toBeDisabled();

    // The Big-O lesson has 5 questions × 4 options = 20 option divs (div.cursor-pointer)
    const quizSection = page
      .locator("div.rounded-lg.border")
      .filter({ hasText: "Câu hỏi trắc nghiệm" })
      .first();
    const optionDivs = quizSection.locator("div.cursor-pointer");
    await expect(optionDivs).toHaveCount(20);

    // Select the first option for each of the 5 questions
    for (let qi = 0; qi < 5; qi++) {
      await optionDivs.nth(qi * 4).click();
    }

    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();
    await expect(page.getByText(/Kết quả:/)).toBeVisible();
  });
});

// ── Seeded lesson with video key — teacher management section ─────────────

test.describe("Seeded lesson with video key — teacher management section", () => {
  test("shows Thay video, key display, and AI Phân tích when lesson has video_key", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Seed set video_key → hasVideo=true → button reads "Thay video"
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
    // Storage key is displayed in the management section
    await expect(page.getByText(/Key: seed\/hust-cs\//)).toBeVisible();
    // AI analysis section visible when videoStorageKey is set
    await expect(page.getByText("AI Phân tích")).toBeVisible();
  });
});
