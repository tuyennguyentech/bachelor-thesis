/**
 * E2E tests for the video pipeline review fixes:
 * - P1-1: video player surfaces a useful error overlay when the source is bad
 * - P3-2: clicking an outline chunk in the student sidebar seeks the video
 */

import { test, expect, SEED_HUST_CS_SLUG, SEED_DSA_COURSE_TITLE, SEED_DSA_LESSON_BIG_O } from "../fixtures";

const ORG_SLUG = SEED_HUST_CS_SLUG;
const COURSE_TITLE = SEED_DSA_COURSE_TITLE;
const LESSON_TITLE = SEED_DSA_LESSON_BIG_O;

async function openLessonAsStudent(page: import("@playwright/test").Page) {
  await page.goto(`/dashboard/organizations/${ORG_SLUG}/courses?q=${encodeURIComponent(COURSE_TITLE)}`);
  const row = page.getByRole("row").filter({ hasText: COURSE_TITLE });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Course not found: ${COURSE_TITLE}`);
  await page.goto(courseHref);
  const lessonHref = await page.getByRole("link").filter({ hasText: LESSON_TITLE }).first().getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson not found: ${LESSON_TITLE}`);
  await page.goto(lessonHref);
  await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 20000 });
}

test.describe("Video pipeline review fixes", () => {
  test("P1-1: video player shows error overlay when the source URL is bad", async ({ studentPage: page }) => {
    await openLessonAsStudent(page);

    // Wait for the video element to mount, then force an error by swapping the
    // src to a 404 URL. The onError handler should reveal the error overlay
    // with a Vietnamese message instead of leaving a silent black screen.
    const video = page.locator("video").first();
    await expect(video).toBeVisible();
    // Wait until the video has metadata so the next `load()` reliably fires
    // an `error` event instead of being cancelled by a pending initial load.
    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 15000,
      })
      .toBeGreaterThanOrEqual(1);
    await video.evaluate((el: HTMLVideoElement) => {
      el.src = "http://caddy/api/storage/nonexistent-key.mp4";
      el.load();
      el.dispatchEvent(new Event("error"));
    });

    // The browser fires `error` async — wait for the overlay.
    const overlay = page.getByTestId("video-error-overlay");
    await expect(overlay).toBeVisible({ timeout: 10000 });
    // Match any of the localized error messages emitted by handleError.
    await expect(overlay).toContainText(
      /Lỗi|không thể|video|liên kết|hết hạn|định dạng|mạng|kết nối|dừng|nguồn/i,
    );
    await expect(overlay.getByRole("button", { name: /thử lại/i })).toBeVisible();
  });

  test("P3-2: clicking an outline chunk in the student sidebar seeks the video", async ({ studentPage: page }) => {
    await openLessonAsStudent(page);

    // The student sidebar's outline tab is only present when chunks exist.
    // DSA lessons are seeded with analysis, so chunks should be available.
    // Use exact match to avoid the "Thu gọn dàn bài" collapse button.
    const outlineTab = page.getByRole("button", { name: "Dàn bài", exact: true });
    await outlineTab.click();

    // Find a chunk button with a non-zero start time. Skip chunk 0 because
    // it might overlap the natural initial seek position.
    const chunkButtons = page.locator("[data-testid^='outline-chunk-']");
    const count = await chunkButtons.count();
    if (count === 0) {
      test.skip(true, "Lesson has no chunks to test against — analysis may not have run on the seed video");
      return;
    }
    let targetSeconds = 0;
    let targetIdx = -1;
    for (let i = 0; i < count; i++) {
      const secs = Number(await chunkButtons.nth(i).getAttribute("data-start-seconds"));
      if (Number.isFinite(secs) && secs > 5) {
        targetSeconds = secs;
        targetIdx = i;
        break;
      }
    }
    expect(targetIdx).toBeGreaterThanOrEqual(0);

    // The VideoPlayer is mounted inside StudentLessonView. The student
    // sidebar's `seekTo` writes directly to the shared video ref AND
    // dispatches a `seek-video` window event as a fallback.
    const video = page.locator("video").first();
    await expect(video).toBeVisible();
    await chunkButtons.nth(targetIdx).click();
    await expect.poll(async () => {
      return await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    }, { timeout: 5000 }).toBeCloseTo(targetSeconds, 0);
  });
});
