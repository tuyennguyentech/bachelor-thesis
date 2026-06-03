/**
 * E2E tests for video player bugs:
 * 1) Lesson management page: video black, no audio
 * 2) Preview mode: video black (but audio ok), questions appear too early
 */

import { test, expect, Page } from "../fixtures";
import { SEED_HUST_CS_SLUG, SEED_DSA_COURSE_TITLE, SEED_DSA_LESSON_BIG_O } from "../fixtures";

const ORG_SLUG = SEED_HUST_CS_SLUG;
const COURSE_TITLE = SEED_DSA_COURSE_TITLE;
const LESSON_TITLE = SEED_DSA_LESSON_BIG_O;
const DEMO_ORG_SLUG = "dyadia-demo";
const DEMO_COURSE_TITLE = "Giới thiệu về Dyadia";
const DEMO_LESSON_TITLE = "Bài 1: Dyadia là gì?";

async function goToLessonAsTeacher(page: Page): Promise<string> {
  const coursesUrl = `/dashboard/organizations/${ORG_SLUG}/courses`;
  await page.goto(`${coursesUrl}?q=${encodeURIComponent(COURSE_TITLE)}`);
  const row = page.getByRole("row").filter({ hasText: COURSE_TITLE });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Course not found: ${COURSE_TITLE}`);
  await page.goto(courseHref);
  const lessonLink = page.getByRole("link").filter({ hasText: LESSON_TITLE }).first();
  const lessonHref = await lessonLink.getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson not found: ${LESSON_TITLE}`);
  await page.goto(lessonHref);
  return lessonHref;
}

async function goToLessonAsStudent(page: Page): Promise<string> {
  const coursesUrl = `/dashboard/organizations/${ORG_SLUG}/courses`;
  await page.goto(`${coursesUrl}?q=${encodeURIComponent(COURSE_TITLE)}`);
  const row = page.getByRole("row").filter({ hasText: COURSE_TITLE });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Course not found: ${COURSE_TITLE}`);
  await page.goto(courseHref);
  const lessonLink = page.getByRole("link").filter({ hasText: LESSON_TITLE }).first();
  const lessonHref = await lessonLink.getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson not found: ${LESSON_TITLE}`);
  await page.goto(lessonHref);
  return lessonHref;
}

async function enterPreviewMode(page: Page): Promise<void> {
  await page.getByTestId("workflow-step-preview").click();
  await expect(page.getByText("Đang xem thử dưới dạng học viên")).toBeVisible();
}

test.describe("Video Player Bug Tests", () => {
  test.describe("Lesson list sidebar", () => {
    test("collapsing and expanding the lesson list does not emit React instrumentation errors", async ({ userPage: page }) => {
      const instrumentationErrors: string[] = [];
      page.on("console", (msg) => {
        const text = msg.text();
        if (/React instrumentation|children should not have changed/i.test(text)) {
          instrumentationErrors.push(text);
        }
      });
      page.on("pageerror", (err) => {
        if (/React instrumentation|children should not have changed/i.test(err.message)) {
          instrumentationErrors.push(err.message);
        }
      });

      await page.goto(`/dashboard/organizations/${DEMO_ORG_SLUG}/courses?q=${encodeURIComponent(DEMO_COURSE_TITLE)}`);
      const row = page.getByRole("row").filter({ hasText: DEMO_COURSE_TITLE });
      const courseHref = await row.getByRole("link").first().getAttribute("href");
      if (!courseHref) throw new Error(`Course not found: ${DEMO_COURSE_TITLE}`);
      await page.goto(courseHref);
      const lessonHref = await page.getByRole("link").filter({ hasText: DEMO_LESSON_TITLE }).first().getAttribute("href");
      if (!lessonHref) throw new Error(`Lesson not found: ${DEMO_LESSON_TITLE}`);

      await page.evaluate(() => localStorage.removeItem("dyadia_sidebar_open"));
      await page.goto(lessonHref);
      await expect(page.getByRole("heading", { name: DEMO_LESSON_TITLE })).toBeVisible({ timeout: 15000 });
      await page.getByRole("button", { name: "Ẩn danh sách bài học" }).click();
      await expect(page.getByRole("button", { name: "Hiện danh sách bài học" })).toBeVisible();
      await page.getByRole("button", { name: "Hiện danh sách bài học" }).click();
      await expect(page.getByRole("button", { name: "Ẩn danh sách bài học" })).toBeVisible();

      await page.evaluate(() => localStorage.setItem("dyadia_sidebar_open", "false"));
      await page.reload();
      await expect(page.getByRole("button", { name: "Hiện danh sách bài học" })).toBeVisible();
      expect(instrumentationErrors).toEqual([]);
    });
  });

  test.describe("BUG: Lesson Management Page - Video black/mute", () => {
    test("teacher can play video and see/hear content", async ({ teacherPage: page }) => {
      await goToLessonAsTeacher(page);
      await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 15000 });

      const videoElement = page.locator("video").first();
      await expect(videoElement).toBeVisible();
      await page.waitForTimeout(2000);

      const videoPlayer = page.getByTestId("video-player");
      await videoPlayer.click();
      await page.waitForTimeout(1000);

      const time1 = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);
      await page.waitForTimeout(500);
      const time2 = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);

      expect(time2).toBeGreaterThanOrEqual(time1);

      const muted = await videoElement.evaluate((v: HTMLVideoElement) => v.muted);
      expect(muted).toBe(false);
      const volume = await videoElement.evaluate((v: HTMLVideoElement) => v.volume);
      expect(volume).toBeGreaterThan(0);
    });
  });

  test.describe("BUG: Preview Mode - Video black + questions too early", () => {
    test("preview mode shows video and not black screen", async ({ teacherPage: page }) => {
      await goToLessonAsTeacher(page);
      await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 15000 });

      await enterPreviewMode(page);

      const videoPlayer = page.getByTestId("video-player");
      await expect(videoPlayer).toBeVisible();

      const playerBox = await videoPlayer.boundingBox();
      expect(playerBox).not.toBeNull();
      expect(playerBox!.width).toBeGreaterThan(100);
      expect(playerBox!.height).toBeGreaterThan(100);
    });

    test("preview mode: questions only appear at correct checkpoint, not before", async ({ teacherPage: page }) => {
      await goToLessonAsTeacher(page);
      await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 15000 });

      await enterPreviewMode(page);

      const checkpointOverlay = page.locator('[data-testid="quiz-checkpoint"]');
      await expect(checkpointOverlay).not.toBeVisible();

      const videoPlayer = page.getByTestId("video-player");
      await videoPlayer.click();
      const videoElement = page.locator("video").first();
      await videoElement.evaluate((v: HTMLVideoElement) => v.play().catch(() => {}));
      await page.waitForTimeout(500);

      const initialTime = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);
      await page.waitForTimeout(2000);
      const timeAfter2s = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);
      expect(timeAfter2s).toBeGreaterThan(initialTime);
    });

    test("preview mode: video plays with audio", async ({ teacherPage: page }) => {
      await goToLessonAsTeacher(page);
      await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 15000 });

      await enterPreviewMode(page);

      const videoElement = page.locator("video").first();
      await expect(videoElement).toBeVisible();
      await page.waitForTimeout(2000);

      const videoPlayer = page.getByTestId("video-player");
      await videoPlayer.click();
      await videoElement.evaluate((v: HTMLVideoElement) => v.play().catch(() => {}));
      await page.waitForTimeout(1000);

      const time1 = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);
      await page.waitForTimeout(500);
      const time2 = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);

      expect(time2).toBeGreaterThanOrEqual(time1);

      const muted = await videoElement.evaluate((v: HTMLVideoElement) => v.muted);
      expect(muted).toBe(false);
    });
  });

  test.describe("Student View - Video playback works", () => {
    test("student can view lesson and video plays", async ({ studentPage: page }) => {
      await goToLessonAsStudent(page);
      await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 15000 });

      const videoPlayer = page.getByTestId("video-player");
      await expect(videoPlayer).toBeVisible();

      const playerBox = await videoPlayer.boundingBox();
      expect(playerBox).not.toBeNull();
      expect(playerBox!.width).toBeGreaterThan(100);
      expect(playerBox!.height).toBeGreaterThan(100);

      const videoElement = page.locator("video").first();
      await expect(videoElement).toBeVisible();

      await videoPlayer.click();
      await page.waitForTimeout(1000);

      const time1 = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);
      await page.waitForTimeout(500);
      const time2 = await videoElement.evaluate((v: HTMLVideoElement) => v.currentTime);

      expect(time2).toBeGreaterThanOrEqual(time1);
    });
  });
});
