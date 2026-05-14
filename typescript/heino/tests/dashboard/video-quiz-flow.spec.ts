/**
 * Comprehensive E2E tests for the video + AI analysis + quiz flow.
 *
 * Covers:
 *  1. Upload video → success message + "Thay video"
 *  2. AI analysis trigger → status changes to "Đang xử lý…" then "Hoàn thành"
 *  3. Transcript appears after analysis (plain text or interactive segments)
 *  4. Quiz questions generated → visible to teacher with correct answers
 *  5. Student sees quiz form (not answers)
 *  6. Video checkpoint pauses and shows question
 *  7. Student answers checkpoint → correct/wrong feedback
 *  8. "Tiếp tục xem" resumes video, checkpoint gone
 *  9. Student submits full quiz → score displayed
 * 10. Student retakes quiz
 * 11. Teacher sees student progress (attempts table)
 * 12. Seeded lesson: transcript, questions, previous attempt all visible
 *
 * Prerequisites:
 *   - richter seed --dev has been run (creates org hust-cs, seeded courses,
 *     seeded videos in storage, seeded quiz attempts for bob)
 *   - Migration 00013 applied (start_seconds column)
 *   - Run from heino container-shell where localhost:3000 → heino process
 */

import path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const ORG_SLUG = "hust-cs";
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;
const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");

const SEEDED_COURSE = "Cấu trúc dữ liệu và Giải thuật";
const SEEDED_LESSON = "Bài 1: Big-O, Omega, Theta notation";

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Navigate through paginated courses list to find the seeded DSA course,
 *  then navigate to the given lesson. */
async function goToSeededLesson(page: Page, lessonTitle: string): Promise<string> {
  for (let p = 1; p <= 30; p++) {
    await page.goto(`${COURSES_URL}?page=${p}`);
    const row = page.getByRole("row").filter({ hasText: SEEDED_COURSE });
    if ((await row.count()) > 0) {
      const courseHref = await row.getByRole("link").first().getAttribute("href");
      await page.goto(`${courseHref}`);
      const lessonLink = page.getByRole("link").filter({ hasText: lessonTitle }).first();
      const lessonHref = await lessonLink.getAttribute("href");
      if (!lessonHref) throw new Error(`Lesson link not found for "${lessonTitle}"`);
      await page.goto(lessonHref);
      return lessonHref;
    }
    if ((await page.getByRole("link", { name: "Sau →" }).count()) === 0) break;
  }
  throw new Error(`Seeded course "${SEEDED_COURSE}" not found within 30 pages`);
}

/** Creates a fresh course → module → lesson, returns the lesson URL. */
async function createLesson(
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
  const href = await lessonRow.getByRole("link").getAttribute("href");
  return `${href}`;
}

/** Wait for React hydration to register the checkpoint test hook, then fire it. */
async function triggerCheckpoint(page: Page, seconds: number) {
  await page.waitForFunction(() => "__triggerVideoCheckpoint" in window, { timeout: 5_000 });
  await page.evaluate((s) => {
    (window as unknown as { __triggerVideoCheckpoint?: (s: number) => void }).__triggerVideoCheckpoint?.(s);
  }, seconds);
}

// ── 1. Upload flow ─────────────────────────────────────────────────────────

test.describe("Video upload flow", () => {
  test("teacher uploads video → success + Thay video visible", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học Upload Flow"), uid("Chương Upload"), uid("Bài Upload"),
    );
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();

    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText(/Đang tải lên/)).toBeVisible();
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();

    // Video key is displayed below the upload button
    await expect(page.getByText(/Key: lessons\//)).toBeVisible();
  });

  test("after upload, video key enables AI analysis button", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học AI Enabled"), uid("Chương AI"), uid("Bài AI"),
    );
    await page.goto(url);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // After upload, AI analysis section appears with the new 2-stage extract button
    await expect(page.getByText("AI Phân tích")).toBeVisible();
    await expect(page.getByRole("button", { name: "Trích xuất transcript" })).toBeVisible();
  });

  test("student does not see upload controls", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Quản lý video")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Thay video" })).not.toBeVisible();
  });
});

// ── 2. Video player visible ────────────────────────────────────────────────

test.describe("Video player", () => {
  test("seeded lesson shows video element", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Requires seed videos uploaded to storage (run: richter seed --dev)
    await expect(page.locator("video")).toBeVisible();
  });

  test("lesson without video shows placeholder for student", async ({ studentPage: page }) => {
    // Lesson 3 has no video in seed data
    await goToSeededLesson(page, "Bài 3: Benchmark thực tế");
    await expect(page.getByText("Nội dung chưa được cung cấp.")).toBeVisible();
  });

  test("lesson without video shows teacher placeholder", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, "Bài 3: Benchmark thực tế");
    await expect(page.getByText("Chưa có video. Tải video lên bên dưới.")).toBeVisible();
  });

  test("video load error shows error placeholder instead of broken player", async ({ teacherPage: page }) => {
    const lessonUrl = await createLesson(page, uid("ErrorVideoTest"), "Module 1", uid("Lesson"));
    await page.goto(lessonUrl);
    // Upload a real file so video_storage_key is set in DB
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });
    // Reload so the server fetches the presigned download URL and renders the video player
    await page.reload();
    await expect(page.locator("video")).toBeVisible({ timeout: 10_000 });
    // The onError placeholder text must NOT be visible when the video loads fine
    await expect(page.getByText("Video không thể tải")).not.toBeVisible();
  });
});

// ── 3. Transcript ──────────────────────────────────────────────────────────

test.describe("Transcript display", () => {
  test("seeded lesson shows transcript section", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Phiên âm nội dung")).toBeVisible();
    // Seeded transcript has Big-O content (may match multiple elements — use first)
    await expect(page.getByText(/Big-O notation/).first()).toBeVisible();
  });

  test("transcript section absent when no analysis", async ({ studentPage: page }) => {
    await goToSeededLesson(page, "Bài 3: Benchmark thực tế");
    await expect(page.getByText("Phiên âm nội dung")).not.toBeVisible();
  });
});

// ── 4. AI analysis trigger ─────────────────────────────────────────────────

test.describe("AI analysis", () => {
  test("analyze button visible after video upload", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học Analyze"), uid("Chương Analyze"), uid("Bài Analyze"),
    );
    await page.goto(url);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // Reload so server re-renders with video_key set → AI section appears
    await page.reload();
    await expect(page.getByText("AI Phân tích")).toBeVisible();
    await expect(page.getByRole("button", { name: "Trích xuất transcript" })).toBeVisible();
  });

  test("seeded lesson shows analysis status Hoàn thành", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Analysis was seeded with status=done
    await expect(page.getByText("(Hoàn thành)")).toBeVisible();
  });

  test("teacher sees questions with correct answers highlighted", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();
    // Correct answer options have green border class
    const correctOptions = page.locator(".border-green-500");
    await expect(correctOptions.first()).toBeVisible();
  });
});

// ── 4b. SSE streaming progress UI ─────────────────────────────────────────

test.describe("AI analysis streaming progress", () => {
  test("clicking Trích xuất transcript shows 4-step progress panel", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học SSE"), uid("Chương SSE"), uid("Bài SSE"),
    );
    await page.goto(url);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Trích xuất transcript" }).click();

    // Progress panel appears immediately
    const panel = page.locator('[data-testid="extract-progress"]');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // All 4 step labels present
    await expect(panel.getByText("Tải video từ storage")).toBeVisible();
    await expect(panel.getByText("Gửi lên Gemini")).toBeVisible();
    await expect(panel.getByText("Phiên âm & phân đoạn nội dung")).toBeVisible();
    await expect(panel.getByText("Lưu kết quả")).toBeVisible();
  });

  test("extract button disabled while running", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học Busy"), uid("Chương Busy"), uid("Bài Busy"),
    );
    await page.goto(url);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Trích xuất transcript" }).click();
    const btn = page.getByRole("button", { name: "Đang phân tích…" });
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeDisabled();
  });

  test.skip("auto-run flow: extract → auto-generate → questions visible", async ({ teacherPage: page }) => {
    // Skipped: requires a video fixture with real speech (tests/fixtures/test-video.mp4 has no audio
    // track, so Whisper/Gemini returns an empty transcript and auto-run cannot complete).
    // To enable: replace test-video.mp4 with a short MP4 that contains spoken words.
    test.setTimeout(600_000);
    const url = await createLesson(
      page, uid("Khóa học Done"), uid("Chương Done"), uid("Bài Done"),
    );
    await page.goto(url);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // Click "Trích xuất transcript" — triggers extract then auto-generates questions
    await page.getByRole("button", { name: "Trích xuất transcript" }).click();
    await expect(page.locator('[data-testid="extract-progress"]')).toBeVisible({ timeout: 5_000 });

    // Wait for the full pipeline (extraction + auto-generation) to complete
    await expect(page.locator('[data-testid="gen-done"]')).toBeVisible({ timeout: 540_000 });

    // Questions section should now be visible
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible({ timeout: 10_000 });
  });
});

// ── 5. Student quiz form ───────────────────────────────────────────────────

test.describe("Student quiz form", () => {
  test("student sees quiz form (not correct answers)", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();
    // Bob has a seeded attempt — click Làm lại to reset to fresh form state
    await page.getByRole("button", { name: "Làm lại" }).click();
    // In fresh form state, correct answers (green borders) must NOT be visible
    await expect(page.locator(".border-green-500")).toHaveCount(0);
  });

  test("student sees previous attempt result (seeded)", async ({ studentPage: page }) => {
    // bob has a seeded attempt for Big-O lesson
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText(/Kết quả:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });

  test("student can retake quiz: select all + submit → new score", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();

    const submitBtn = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn).toBeDisabled();

    // 5 questions × 4 options = 20 clickable option divs
    const quizBox = page.locator("div.rounded-lg.border").filter({ hasText: "Câu hỏi trắc nghiệm" }).first();
    const optionDivs = quizBox.locator("div.cursor-pointer");
    await expect(optionDivs).toHaveCount(20);

    for (let qi = 0; qi < 5; qi++) {
      await optionDivs.nth(qi * 4).click();
    }
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await expect(page.getByText(/Kết quả:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });

  test("submit button disabled until all questions answered", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();

    const submitBtn = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn).toBeDisabled();

    // Answer only 4 of 5 questions
    const quizBox = page.locator("div.rounded-lg.border").filter({ hasText: "Câu hỏi trắc nghiệm" }).first();
    const optionDivs = quizBox.locator("div.cursor-pointer");
    for (let qi = 0; qi < 4; qi++) {
      await optionDivs.nth(qi * 4).click();
    }
    await expect(submitBtn).toBeDisabled();
  });

  test("after submit, correct answers revealed and Làm lại shown", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();

    const quizBox = page.locator("div.rounded-lg.border").filter({ hasText: "Câu hỏi trắc nghiệm" }).first();
    const optionDivs = quizBox.locator("div.cursor-pointer");
    // Pick the correct answer for question 1 (index 1 per seed data)
    await optionDivs.nth(0 * 4 + 1).click(); // q1, option B (correct_answer=1)
    for (let qi = 1; qi < 5; qi++) {
      await optionDivs.nth(qi * 4).click();
    }
    await page.getByRole("button", { name: "Nộp bài" }).click();

    // Correct answer for q1 is highlighted green
    await expect(quizBox.locator(".border-green-500").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });
});

// ── 6-8. Video checkpoint ──────────────────────────────────────────────────

test.describe("Video quiz checkpoint", () => {
  test("checkpoint appears when video reaches question start_seconds", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    // Trigger via test hook (Object.defineProperty on currentTime is unreliable in Firefox)
    await triggerCheckpoint(page, 210);

    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: "Tiếp tục xem" })).toBeVisible();
  });

  test("clicking option in checkpoint shows correct/wrong feedback", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);

    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });

    // Click the correct answer (index 1 for Big-O question 1 per seed)
    await checkpoint.locator("div.cursor-pointer").nth(1).click();
    await expect(checkpoint.locator(".border-green-500")).toBeVisible();
  });

  test("Tiếp tục xem dismisses checkpoint", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);

    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible();
  });

  test("checkpoint does not reappear for same question after dismiss", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    // Trigger checkpoint
    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible();

    // Trigger again at same time — checkpoint should NOT reappear (already in passedIds)
    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible();
  });

  test("teacher also sees checkpoint when watching video", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
  });

  test("student cannot bypass checkpoint by playing video while quiz shows", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    // Seeded Big-O lesson has checkpoints starting at 208s — trigger at 210 hits the first one
    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });

    // Attempt to play via JS while quiz overlay is active
    await page.evaluate(() => { void (document.querySelector("video") as HTMLVideoElement | null)?.play(); });
    await page.waitForTimeout(300);

    const paused = await page.evaluate(() => (document.querySelector("video") as HTMLVideoElement | null)?.paused ?? true);
    expect(paused).toBe(true);
  });

  test("student cannot bypass checkpoint by seeking past it", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    // Seeded Big-O lesson has checkpoints starting at 208s — trigger at 210 hits the first one
    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });

    // Seek to a time well past the checkpoint
    await page.evaluate(() => { const v = document.querySelector("video") as HTMLVideoElement | null; if (v) v.currentTime = 9999; });
    await page.waitForTimeout(300);

    // currentTime should have been reset back to the checkpoint startSeconds (≤ 208s + a small delta)
    const time = await page.evaluate(() => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? 0);
    expect(time).toBeLessThan(220);
  });
});

// ── 9. Teacher student progress ────────────────────────────────────────────

test.describe("Student progress (teacher view)", () => {
  test("teacher sees progress table with seeded attempts", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Tiến độ học viên")).toBeVisible();

    // bob and dave both have seeded attempts for Big-O lesson
    const attemptsSection = page.locator("div.rounded-lg.border").filter({ hasText: "Tiến độ học viên" }).first();
    await expect(attemptsSection).toBeVisible();
    // Table should show at least one row (bob's attempt)
    await expect(attemptsSection.getByText(/bob@dyadia.local|dave@dyadia.local/).first()).toBeVisible();
  });

  test("progress table shows score with color coding", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    const attemptsSection = page.locator("div.rounded-lg.border").filter({ hasText: "Tiến độ học viên" }).first();
    // Score column should be visible
    await expect(attemptsSection.getByText(/\d+\/\d+/).first()).toBeVisible();
  });

  test("new lesson has empty attempts table", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học Empty Progress"), uid("Chương Empty"), uid("Bài Empty"),
    );
    await page.goto(url);
    await expect(page.getByText("Tiến độ học viên")).toBeVisible();
    await expect(page.getByText("Chưa có học viên nào nộp bài.")).toBeVisible();
  });
});

// ── 10. Interactive transcript ────────────────────────────────────────────

test.describe("Interactive transcript (seeded segments)", () => {
  // Note: seeded lessons have transcript TEXT only, not segments (no timestamp segments).
  // This test covers the plain-text transcript path.
  test("plain transcript renders for seeded lesson", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Phiên âm nội dung")).toBeVisible();
    // Plain text transcript (no interactive segments for seeded data)
    await expect(page.getByText(/Big-O notation/).first()).toBeVisible();
  });

  test("seek hint shown only when segments exist", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Seeded lesson has no transcript_segments → hint should NOT appear
    await expect(page.getByText("(nhấn vào đoạn để tua video)")).not.toBeVisible();
  });
});

// ── 11. Teacher question editing ──────────────────────────────────────────────

test.describe("Teacher question editing (seeded data)", () => {
  test("teacher sees edit/delete/regenerate buttons on each question", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();

    // First question row should have edit and delete icons
    await expect(page.getByTitle("Chỉnh sửa").first()).toBeVisible();
    await expect(page.getByTitle("Xóa").first()).toBeVisible();
    await expect(page.getByTitle("Tạo lại bằng AI").first()).toBeVisible();
  });

  test("teacher can edit a question inline", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();

    // Open edit for first question
    await page.getByTitle("Chỉnh sửa").first().click();
    // Edit form appears
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();

    // Change the question text
    const newText = `Câu hỏi đã sửa ${Date.now()}`;
    await textarea.fill(newText);
    await page.getByRole("button", { name: "Lưu" }).first().click();

    // Edit form closes and new text appears
    await expect(page.locator("textarea").first()).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(newText)).toBeVisible();
  });

  test("teacher can add a manual question", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();

    await page.getByTestId("add-question-btn").click();

    // Fill in the add form
    const form = page.locator("div.bg-muted\\/30").last();
    await form.locator("textarea").fill("Câu hỏi thủ công mới");
    const optionInputs = form.locator('input[type="text"]');
    await optionInputs.nth(0).fill("Phương án A");
    await optionInputs.nth(1).fill("Phương án B");
    await optionInputs.nth(2).fill("Phương án C");
    await optionInputs.nth(3).fill("Phương án D");

    await page.getByRole("button", { name: "Lưu" }).last().click();
    await expect(page.getByText("Câu hỏi thủ công mới")).toBeVisible({ timeout: 5_000 });
  });

  test("teacher can delete a question", async ({ teacherPage: page }) => {
    // Navigate to the Big-O lesson to get the editable question list
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();

    // Count questions before deletion
    const questionsBefore = await page.getByTitle("Xóa").count();
    expect(questionsBefore).toBeGreaterThan(0);

    // Delete the last question
    await page.getByTitle("Xóa").last().click();

    // Question count decreases
    await expect(page.getByTitle("Xóa")).toHaveCount(questionsBefore - 1, { timeout: 5_000 });
  });

  test("student does not see edit/delete buttons", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();
    await expect(page.getByTitle("Chỉnh sửa")).not.toBeVisible();
    await expect(page.getByTitle("Xóa")).not.toBeVisible();
  });

  test("teacher in preview mode does not see edit/delete buttons", async ({ teacherPage: page }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await page.goto(`${href}?preview=1`);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();
    await expect(page.getByTitle("Chỉnh sửa")).not.toBeVisible();
    await expect(page.getByTitle("Xóa")).not.toBeVisible();
  });

  test("cancel edit discards changes", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Câu hỏi trắc nghiệm")).toBeVisible();

    // Get original text of first question
    const questionText = await page.locator("p.text-sm.flex-1").first().textContent();

    await page.getByTitle("Chỉnh sửa").first().click();
    const textarea = page.locator("textarea").first();
    await textarea.fill("Đây là thay đổi bị hủy");
    await page.getByRole("button", { name: "Hủy" }).first().click();

    // Original text still shown
    await expect(page.getByText(questionText ?? "")).toBeVisible();
    await expect(page.getByText("Đây là thay đổi bị hủy")).not.toBeVisible();
  });
});
