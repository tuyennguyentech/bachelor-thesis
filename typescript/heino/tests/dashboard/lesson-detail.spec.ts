/**
 * E2E tests for dashboard lesson detail page.
 *
 * Tests that:
 * - Lesson title is visible for all roles
 * - Video upload section is visible to teacher/admin
 * - Video upload section is hidden from student
 * - Lesson rows in course detail are clickable links
 */

import { test, expect } from "../fixtures";

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
    const courseUrl = `http://localhost:3000${href}`;
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
    await page.goto(`http://localhost:3000${lessonHref}`);

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
    await page.goto(`http://localhost:3000${courseHref}`);

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
    lessonUrl = `http://localhost:3000${href}`;
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
    await page.goto(`http://localhost:3000${courseHref}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // If there are any lesson rows, click the first one
    const lessonLinks = page.locator("div.border a");
    const count = await lessonLinks.count();
    if (count === 0) {
      // No lessons in this course — skip
      return;
    }
    const href = await lessonLinks.first().getAttribute("href");
    await page.goto(`http://localhost:3000${href}`);

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
    await page.goto(`http://localhost:3000${courseHref}`);

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
    await page.goto(`http://localhost:3000${href}`);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Tiến độ học viên")).toBeVisible();
  });
});
