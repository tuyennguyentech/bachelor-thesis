/**
 * E2E tests for the video upload flow on lesson detail pages.
 *
 * Requires the dyadia storage bucket to exist (run `richter seed` first).
 *
 * Flow under test:
 *   1. Teacher navigates to a lesson detail page → ?tab=processing
 *   2. Clicks "Tải video lên" → hidden <input type="file"> receives test-video.mp4
 *   3. Component calls getUploadUrl → XHR PUT → localhost/api/storage (Caddy → SeaweedFS)
 *   4. Component calls updateLessonVideo to persist the key in the DB
 *   5. UI shows success; button label changes to "Thay video"
 *   6. On page reload (with ?tab=processing), "Thay video" persists (server-rendered with stored key)
 *
 * NOTE: The video upload UI lives exclusively in ?tab=processing (via AnalyzeButton →
 * AnalysisWorkflowShell → VideoUpload).  All tests MUST navigate to ?tab=processing
 * before asserting or interacting with the upload widget.
 */

import path from "path";
import type { Page } from "@playwright/test";
import { test, expect, goToSeededLesson, SEED_DSA_LESSON_BIG_O } from "../fixtures";

const ORG_SLUG = "hust-cs";
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;
const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Creates a course → module → lesson and returns the lesson page URL (without tab).
 *  Callers must append ?tab=processing when navigating to the upload UI. */
async function createLessonAndNavigate(
  page: Page,
  courseTitle: string,
  moduleName: string,
  lessonTitle: string,
): Promise<string> {
  await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Tạo khóa học" }).click();
  await page.getByLabel("Tên khóa học").fill(courseTitle);
  await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const row = page.getByRole("row").filter({ hasText: courseTitle });
  const courseHref = await row.getByRole("link").getAttribute("href");
  await page.goto(`${courseHref}`, { waitUntil: "domcontentloaded" });

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
    // The upload UI lives exclusively in ?tab=processing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
  });

  test("student does not see upload button", async ({ studentPage: page }) => {
    // Students get StudentLessonView — the teacher pipeline (including ?tab=processing)
    // is never rendered for them, so the upload button must be absent.
    // Navigate to the seeded lesson so the test is not affected by pagination order.
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
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
    // Navigate to ?tab=processing so the upload widget is visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    // Set file directly on hidden input (bypasses OS file picker)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Progress bar appears while uploading (text: "Đang tải lên máy chủ...")
    await expect(page.getByText(/Đang tải lên/)).toBeVisible();
    // After upload + DB update, the component remounts with videoStorageKey set and the
    // workflow advances to the transcript step. "Trích xuất transcript" is the stable
    // post-upload indicator (the transient "done" toast disappears on remount).
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
  });

  test("button changes from Tải video lên to Thay video after upload", async ({ teacherPage: page }) => {
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // After upload, the component remounts with videoStorageKey set and advances to step 2.
    // Navigate back to the upload step (step 1) to verify the button changed to "Thay video".
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
  });

  test("video key persists after page reload", async ({ teacherPage: page }) => {
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Wait for upload to complete: workflow advances to transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    // Wait for router.refresh() to settle before hard-navigating
    await page.waitForLoadState("networkidle");

    // Hard reload with ?tab=processing — server must render "Thay video" since video_key is now set
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // After reload the activeStep defaults to "transcript" (video exists, no segments yet).
    // Click the stepper button to switch back to the upload step within the pipeline.
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
  });

  test("upload replaces video (Thay video flow)", async ({ teacherPage: page }) => {
    // First upload
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Wait for upload to complete: workflow advances to transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    // Wait for router.refresh() to settle before hard-navigating
    await page.waitForLoadState("networkidle");

    // Reload so button is server-rendered as "Thay video"
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // activeStep defaults to "transcript" after reload when video exists; navigate to upload step
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();

    // Second upload via the replace button (same hidden input, button label irrelevant to setInputFiles)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // After replace, workflow advances to transcript step again — confirms second upload succeeded.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    // Navigate to upload step to verify the button label is still "Thay video"
    await page.getByTestId("workflow-step-upload").click();
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
    // Navigate to ?tab=processing so the upload widget is visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();

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
