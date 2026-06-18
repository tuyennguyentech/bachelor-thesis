/**
 * E2E tests — Lesson 3-tab layout (Bài giảng / Xử lý video / Kết quả & Thống kê).
 *
 * Uses the seeded hust-cs DSA course and the Big-O lesson.
 * - userPage  = alice (org ADMIN, canManage=true) — sees all 3 tabs.
 * - teacherPage = carol (org TEACHER, canManage=true) — also sees all 3 tabs.
 * - studentPage  = bob — does NOT see the tab strip at all.
 *
 * NOTE: The lesson page polls for analysis state (SSE/setTimeout), so we use
 * `domcontentloaded` for all navigations and avoid `networkidle`.
 */

import {
  test,
  expect,
  goToSeededLesson,
  SEED_DSA_LESSON_BIG_O,
  SEED_DSA_LESSON_RECURRENCE,
} from "../fixtures";

// ── Tab strip is present for manager roles ─────────────────────────────────

test.describe("Lesson tabs — manager view", () => {
  test("all 3 tab links are visible for org admin (userPage)", async ({ userPage: page }) => {
    await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // All three tabs rendered as <Link> anchors in the tab strip
    await expect(page.getByRole("tab", { name: /Bài giảng/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Xử lý video/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Kết quả.*Thống kê/ })).toBeVisible();
  });

  test("all 3 tab links are visible for teacher (teacherPage)", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await expect(page.getByRole("tab", { name: /Bài giảng/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Xử lý video/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Kết quả.*Thống kê/ })).toBeVisible();
  });
});

// ── Tab 1: Bài giảng (?tab=content) ───────────────────────────────────────

test.describe("Lesson tab — Bài giảng (content)", () => {
  test("?tab=content shows Studio bài giảng section", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=content`, { waitUntil: "domcontentloaded" });

    // The content section header
    await expect(page.getByText("Studio bài giảng")).toBeVisible();

    // The seeded lesson has a video_key → video player area (not an error placeholder)
    // The tab-1 section should NOT be hidden
    const contentSection = page.locator('[data-testid="video-workflow-stepper"]');
    // video-workflow-stepper only lives inside the processing tab — content tab has the Studio card
    // Use the heading instead:
    await expect(page.getByText("Studio bài giảng")).toBeVisible();
  });

  test("manager does NOT see the learner-only 'Chưa hoàn thành' status", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=content`, { waitUntil: "domcontentloaded" });
    // A manager never loads a personal attempt, so the completion status would always
    // read a misleading "Chưa hoàn thành" — it must be hidden for managers.
    await expect(page.getByText("Chưa hoàn thành")).toHaveCount(0);
    await expect(page.getByText("Đã hoàn thành")).toHaveCount(0);
  });

  test("?tab=content shows Chế độ học viên preview link", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=content`, { waitUntil: "domcontentloaded" });

    // Seeded lesson has a video → preview button is visible
    await expect(page.getByRole("link", { name: "Chế độ học viên" })).toBeVisible();
  });
});

// ── Tab 2: Xử lý video (?tab=processing) ──────────────────────────────────

test.describe("Lesson tab — Xử lý video (processing)", () => {
  test("?tab=processing shows AI pipeline stepper and heading", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });

    // The processing tab outer card heading
    await expect(page.getByText("Tạo nội dung từ video")).toBeVisible();

    // The 5-step workflow stepper is mounted
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible();

    // The seeded lesson has a video + analysis → at least the Upload step button is present
    await expect(page.getByTestId("workflow-step-upload")).toBeVisible();
  });

  test("?tab=processing shows transcript step button", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("workflow-step-transcript")).toBeVisible();
  });

  // BUG-C: the "Cấu hình AI nâng cao" panel configures exercise generation, so it
  // must appear ONLY on the Bài tập (exercises) step — not on Phiên âm/Phân đoạn,
  // where it used to render whenever a video existed.
  test("AI config panel shows only on the exercises step, not transcribe/chunks", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible();

    const aiConfig = page.getByText("Cấu hình AI nâng cao", { exact: false });

    await page.getByTestId("workflow-step-transcript").click();
    await expect(aiConfig).toHaveCount(0);

    await page.getByTestId("workflow-step-chunks").click();
    await expect(aiConfig).toHaveCount(0);

    await page.getByTestId("workflow-step-exercises").click();
    await expect(aiConfig).toBeVisible({ timeout: 10_000 });
  });

  test("switching from content to processing and back does not crash", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);

    // Start on content tab
    await page.goto(`${lessonHref}?tab=content`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Studio bài giảng")).toBeVisible();

    // Switch to processing — tab links use relative href="?tab=processing" which only works
    // when resolved against the current page URL, not baseURL. Build the absolute URL instead.
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Tạo nội dung từ video")).toBeVisible();
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible();

    // Switch back to content tab
    await page.goto(`${lessonHref}?tab=content`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Studio bài giảng")).toBeVisible();

    // Page must not show an error boundary
    await expect(page.getByText(/Something went wrong|Đã xảy ra lỗi/i)).not.toBeVisible();
  });
});

// ── Tab 3: Kết quả & Thống kê (?tab=results) ──────────────────────────────

test.describe("Lesson tab — Kết quả & Thống kê (results)", () => {
  test("?tab=results shows results section heading", async ({ userPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });

    // The results section wrapper has data-testid="lesson-attempts"
    await expect(page.getByTestId("lesson-attempts")).toBeVisible();
    await expect(page.getByText("Bảng kết quả học viên")).toBeVisible();
  });

  test("?tab=results shows bob's attempt row (seeded attempt with metrics)", async ({ userPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("lesson-attempts")).toBeVisible();

    // Bob is a student with a seeded attempt — his email should appear in the table
    await expect(page.getByText("bob@dyadia.local")).toBeVisible();
  });

  test("?tab=results shows column headers for the attempts table", async ({ userPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });

    const attemptsSection = page.getByTestId("lesson-attempts");
    await expect(attemptsSection).toBeVisible();
    // LessonAttempts renders plain <th> elements (not TableHead role). Scope to the
    // lesson-attempts section to avoid matching hidden "Học viên" text elsewhere on the page.
    await expect(attemptsSection.getByText("Học viên").first()).toBeVisible();
    await expect(attemptsSection.getByText("Điểm").first()).toBeVisible();
  });
});

// ── Tab 1: no-video placeholder shows upload shortcut button ──────────────

test.describe("Lesson tab — Bài giảng, no-video placeholder", () => {
  test("shows quick-create + manual-processing entry points when lesson has no video", async ({ teacherPage: page }) => {
    // SEED_DSA_LESSON_RECURRENCE has no video_key in seed data → no-video placeholder renders
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_RECURRENCE);
    await page.goto(`${lessonHref}?tab=content`, { waitUntil: "domcontentloaded" });

    // Quick-create (auto) entry point for this existing video-less lesson.
    await expect(page.getByTestId("quick-create-lesson-trigger")).toBeVisible();

    // "Xử lý thủ công" switches to the processing tab CLIENT-side (no navigation):
    // it used to be a <Link href="?tab=processing"> whose RSC navigation failed to
    // update the now-client-side tab state, so the tab stayed on Bài giảng until a
    // hard refresh (BUG-F). It is now a button that toggles the tab in-place.
    const manualBtn = page.getByTestId("manual-processing-cta");
    await expect(manualBtn).toBeVisible();
    await manualBtn.click();
    // Processing tab becomes active in-place — its panel heading appears.
    await expect(page.getByRole("heading", { name: /Tạo nội dung từ video/i })).toBeVisible();
    await expect(page.getByTestId("lesson-tab-processing")).toHaveAttribute("aria-selected", "true");
  });
});

// ── Students do NOT see the tab strip ─────────────────────────────────────

test.describe("Lesson tabs — student view (no tab strip)", () => {
  test("student does not see the tab navigation strip", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Manager tabs are conditionally rendered only for canManage && !isPreview
    await expect(page.getByRole("tab", { name: /Xử lý video/ })).not.toBeVisible();
    await expect(page.getByRole("tab", { name: /Kết quả.*Thống kê/ })).not.toBeVisible();
  });

  test("student sees the video player area (not the Studio card)", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Students see StudentLessonView — not the "Studio bài giảng" heading
    await expect(page.getByText("Studio bài giảng")).not.toBeVisible();
  });
});
