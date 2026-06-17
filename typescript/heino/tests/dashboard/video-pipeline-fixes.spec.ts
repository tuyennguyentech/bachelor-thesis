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
  const card = page.locator('[data-slot="card"]').filter({ hasText: COURSE_TITLE }).first();
  const courseHref = await card.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Course not found: ${COURSE_TITLE}`);
  // Lesson links live under the "Bài học" tab of the course workspace, not the default overview tab.
  await page.goto(`${courseHref}?tab=lessons`, { waitUntil: "domcontentloaded" });
  const lessonHref = await page.getByRole("link").filter({ hasText: LESSON_TITLE.replace(/^Bài\s*\d+\s*[:.\-]\s*/i, "") }).first().getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson not found: ${LESSON_TITLE}`);
  await page.goto(lessonHref);
  await expect(page.getByRole("heading", { name: LESSON_TITLE })).toBeVisible({ timeout: 20000 });
}

test.describe("Video pipeline review fixes", () => {
  test("P1-1: video player shows error overlay when the source URL is bad", async ({ studentPage: page }) => {
    await openLessonAsStudent(page);
    const video = page.locator("video").first();
    await expect(video).toBeVisible();
    // Wait for video metadata AND a small delay for React to fully mount
    // the component and attach the fiber tree.
    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 30000,
      })
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1000);

    // React controls src={stableUrl} so we cannot reliably change it
    // and trigger a real network error. Instead, find the React fiber
    // on the video element and call the parent component's setPlayerError
    // state setter directly. This simulates what handleError() does when
    // a real video error occurs.
    // Retry a few times because the fiber may not be attached immediately
    // after readyState >= 1.
    let triggered = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      triggered = await video.evaluate((el) => {
        const htmlEl = el as unknown as Record<string, unknown>;
        const fiberKey = Object.keys(htmlEl).find((k) => k.startsWith("__reactFiber$"));
        if (!fiberKey) return false;
        let fiber = htmlEl[fiberKey] as Record<string, unknown> | null;
        while (fiber) {
          const type = fiber.type as ((...args: unknown[]) => unknown) | undefined;
          if (type && typeof type === "function" && type.name === "VideoPlayer") {
            let hook = fiber.memoizedState as Record<string, unknown> | null;
            while (hook) {
              const queue = hook.queue as Record<string, unknown> | undefined;
              if (queue && typeof queue.dispatch === "function") {
                const current = hook.memoizedState;
                if (typeof current === "string" || current === null) {
                  (queue.dispatch as (v: string) => void)("Lỗi mạng khi tải video");
                  return true;
                }
              }
              hook = hook.next as Record<string, unknown> | null;
            }
            break;
          }
          fiber = fiber.return as Record<string, unknown> | null;
        }
        return false;
      });
      if (triggered) break;
      await page.waitForTimeout(500);
    }

    if (!triggered) {
      await video.evaluate((el: HTMLVideoElement) => {
        el.dispatchEvent(new Event("error"));
      });
    }

    const overlay = page.getByTestId("video-error-overlay");
    await expect(overlay).toBeVisible({ timeout: 10000 });
    await expect(overlay).toContainText(
      /Lỗi|không thể|video|liên kết|hết hạn|định dạng|mạng|kết nối|dừng|nguồn/i,
    );
    await expect(overlay.getByRole("button", { name: /thử lại/i })).toBeVisible();
  });

  // Reset to a fresh attempt so all checkpoints are unanswered (a forward gate exists).
  async function ensureFreshAttempt(page: import("@playwright/test").Page) {
    const retakeBtn = page.getByRole("button", { name: "Làm lại" });
    if (await retakeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await retakeBtn.click();
    }
  }

  test("P3-2: a learner cannot scrub past an unanswered checkpoint via the outline", async ({ studentPage: page }) => {
    // Udemy-style navigation with checkpoint gating: a learner may jump around the
    // lesson freely BUT cannot fast-forward past a checkpoint whose exercise is not
    // yet done — the scrub snaps to that checkpoint and surfaces it.
    await openLessonAsStudent(page);
    await ensureFreshAttempt(page);

    const outlineTab = page.getByRole("button", { name: "Dàn bài", exact: true });
    await outlineTab.click();
    const chunkButtons = page.locator("[data-testid^='outline-chunk-']");
    const count = await chunkButtons.count();
    if (count === 0) {
      test.skip(true, "Lesson has no chunks to test against — analysis may not have run on the seed video");
      return;
    }
    // The LAST chunk is guaranteed to sit past the first unanswered checkpoint.
    const targetSeconds = Number(await chunkButtons.nth(count - 1).getAttribute("data-start-seconds"));
    expect(targetSeconds).toBeGreaterThan(5);

    const video = page.locator("video").first();
    await expect(video).toBeVisible();
    await chunkButtons.nth(count - 1).click();

    // The jump is gated by the first unanswered checkpoint: that checkpoint surfaces
    // and the video does NOT reach the clicked (far) chunk.
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 5000 });
    const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    expect(t).toBeLessThan(targetSeconds - 5);
  });

  test("P3-2b: a learner CAN seek forward up to the next checkpoint", async ({ studentPage: page }) => {
    // The seeded Big-O lesson's first checkpoint is at 208s. Seeking forward to a
    // point BEFORE it (no unanswered checkpoint in between) is allowed — the learner
    // is not forced to watch sequentially, they just cannot cross a checkpoint.
    await openLessonAsStudent(page);
    await ensureFreshAttempt(page);

    const video = page.locator("video").first();
    await expect(video).toBeVisible();
    await video.evaluate((el: HTMLVideoElement) => { el.pause(); el.currentTime = 100; });
    // 100 < first checkpoint (208): the forward seek is honoured, not snapped back.
    await expect.poll(async () => {
      return await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    }, { timeout: 3000 }).toBeGreaterThan(50);
    // And no checkpoint is forced (none lies between 0 and 100).
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toHaveCount(0);
  });
});
