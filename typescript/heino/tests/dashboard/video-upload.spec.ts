/**
 * E2E tests for the video upload flow on lesson detail pages.
 *
 * Requires the dyadia storage bucket to exist (run `richter seed` first).
 *
 * Flow under test:
 *   1. Teacher navigates to a lesson detail page
 *   2. Clicks "Tải video lên" → hidden <input type="file"> receives test-video.mp4
 *   3. Component calls getUploadUrl → XHR PUT → localhost/api/storage (Caddy → SeaweedFS)
 *   4. Component calls updateLessonVideo to persist the key in the DB
 *   5. UI shows success; button label changes to "Thay video"
 *   6. On page reload, "Thay video" persists (server-rendered with stored key)
 */

import path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const ORG_SLUG = "hust-cs";
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;
const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Creates a course → module → lesson and navigates to the lesson detail page.
 *  Returns the lesson page URL. */
async function createLessonAndNavigate(
  page: Page,
  courseTitle: string,
  moduleName: string,
  lessonTitle: string,
): Promise<string> {
  await page.goto(COURSES_URL);
  await page.getByRole("button", { name: "Tạo khóa học" }).click();
  await page.getByLabel("Tên khóa học").fill(courseTitle);
  await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const row = page.getByRole("row").filter({ hasText: courseTitle });
  const courseHref = await row.getByRole("link").getAttribute("href");
  await page.goto(`${courseHref}`);

  await page.getByRole("button", { name: "Thêm chương" }).click();
  await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
  await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await page.getByRole("button", { name: "Thêm bài học" }).click();
  await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
  await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
  const lessonHref = await lessonRow.getByRole("link").getAttribute("href");
  const lessonUrl = `${lessonHref}`;
  await page.goto(lessonUrl);
  return lessonUrl;
}

// ── upload button visibility ───────────────────────────────────────────────────

test.describe("Upload button visibility", () => {
  test("teacher sees Tải video lên button on new lesson", async ({ teacherPage: page }) => {
    const lessonUrl = await createLessonAndNavigate(
      page,
      uid("Khóa học Upload Visibility"),
      uid("Chương Visibility"),
      uid("Bài học Visibility"),
    );
    await page.goto(lessonUrl);
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
  });

  test("student does not see upload button", async ({ studentPage: page }) => {
    // Navigate to first seeded course's first lesson
    await page.goto(COURSES_URL);
    const courseHref = await page.getByRole("row").nth(1).getByRole("link").getAttribute("href");
    await page.goto(`${courseHref}`);
    const lessonLinks = page.locator("div.border a");
    if ((await lessonLinks.count()) === 0) return;
    const href = await lessonLinks.first().getAttribute("href");
    await page.goto(`${href}`);
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Thay video" })).not.toBeVisible();
  });
});

// ── full upload flow ───────────────────────────────────────────────────────────

test.describe("Video upload flow", () => {
  let lessonUrl: string;

  test.beforeEach(async ({ teacherPage: page }) => {
    lessonUrl = await createLessonAndNavigate(
      page,
      uid("Khóa học Upload E2E"),
      uid("Chương Upload E2E"),
      uid("Bài học Upload E2E"),
    );
  });

  test("upload shows progress bar then success message", async ({ teacherPage: page }) => {
    await page.goto(lessonUrl);
    // Set file directly on hidden input (bypasses OS file picker)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Progress bar appears while uploading
    await expect(page.getByText(/Đang tải lên/)).toBeVisible();
    // Success message after upload + DB update
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });
  });

  test("button changes from Tải video lên to Thay video after upload", async ({ teacherPage: page }) => {
    await page.goto(lessonUrl);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
  });

  test("video key persists after page reload", async ({ teacherPage: page }) => {
    await page.goto(lessonUrl);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // Hard reload — server must render "Thay video" since video_key is now set
    await page.goto(lessonUrl);
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
  });

  test("upload replaces video (Thay video flow)", async ({ teacherPage: page }) => {
    // First upload
    await page.goto(lessonUrl);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // Reload so button is server-rendered as "Thay video"
    await page.goto(lessonUrl);
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();

    // Second upload via the replace button (same hidden input, button label irrelevant to setInputFiles)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
  });
});

// ── invalid file type ─────────────────────────────────────────────────────────

test.describe("Upload validation", () => {
  test("non-video file shows error", async ({ teacherPage: page }) => {
    const lessonUrl = await createLessonAndNavigate(
      page,
      uid("Khóa học Upload Validation"),
      uid("Chương Validation"),
      uid("Bài học Validation"),
    );
    await page.goto(lessonUrl);

    // Create a minimal fake "image" buffer and set it as a non-video file
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });

    await expect(page.getByText("Chỉ hỗ trợ tệp video")).toBeVisible();
    // Upload button stays unchanged
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
  });
});
