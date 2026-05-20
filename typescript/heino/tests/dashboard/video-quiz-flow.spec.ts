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
import {
  test,
  expect,
  goToSeededLesson,
  SEED_HUST_CS_SLUG as ORG_SLUG,
  SEED_DSA_LESSON_BIG_O as SEEDED_LESSON,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;
const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");
const TEST_VIDEO_WITH_AUDIO = path.join(__dirname, "../fixtures/edu-sample.mp4");

function uid(base: string) {
  return `${base} ${Date.now()}`;
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
    (window as unknown as { __triggerVideoCheckpoint: (s: number) => void }).__triggerVideoCheckpoint(s);
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
    // Transcript is in the LessonSidebar under the "Phiên âm" tab
    await expect(page.getByRole("button", { name: "Phiên âm" })).toBeVisible();
    // Seeded transcript has Big-O content (may match multiple elements — use first)
    await expect(page.getByText(/Big-O notation/).first()).toBeVisible();
  });

  test("transcript section absent when no analysis", async ({ studentPage: page }) => {
    await goToSeededLesson(page, "Bài 3: Benchmark thực tế");
    // Sidebar only appears when there are chunks/segments/transcript
    await expect(page.getByRole("button", { name: "Phiên âm" })).not.toBeVisible();
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
    // Questions are inside the AnalyzeButton "Bài tập" tab for teachers
    await page.getByRole("button", { name: "Bài tập" }).click();
    // After redesign: chunk-based layout with per-chunk interaction cards
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5000 });
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

    // All 4 step labels present (Whisper-only pipeline, no Gemini in extraction)
    await expect(panel.getByText("Tải video từ storage")).toBeVisible();
    await expect(panel.getByText("Trích xuất âm thanh")).toBeVisible();
    await expect(panel.getByText("Phiên âm bằng Whisper")).toBeVisible();
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
    const btn = page.getByRole("button", { name: "Đang trích xuất…" });
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toBeDisabled();
  });

  test("3-stage manual flow: extract → chunk → generate → questions visible", async ({ teacherPage: page }) => {
    test.setTimeout(600_000);
    const url = await createLesson(
      page, uid("Khóa học Done"), uid("Chương Done"), uid("Bài Done"),
    );
    await page.goto(url);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // Step 1: Extract transcript (extract-only, no auto-run)
    await page.getByRole("button", { name: "Trích xuất transcript" }).click();
    await expect(page.getByRole("button", { name: "Đang trích xuất…" })).toBeVisible({ timeout: 5_000 });
    // Wait for extraction to finish — button returns to "Trích xuất lại transcript" on success
    await expect(
      page.getByRole("button", { name: "Trích xuất lại transcript" }).or(page.locator('[data-testid="extract-error"]')),
    ).toBeVisible({ timeout: 360_000 });
    await expect(page.locator('[data-testid="extract-error"]')).not.toBeVisible();

    // Step 2: Chunk transcript
    await page.getByRole("button", { name: "Phân đoạn video" }).click();
    await page.getByRole("button", { name: "Phân đoạn lại" }).click();
    await expect(page.getByRole("button", { name: "Đang phân đoạn…" })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: "Phân đoạn lại" }).or(page.locator('[data-testid="chunk-error"]')),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('[data-testid="chunk-error"]')).not.toBeVisible();

    // Step 3: Generate questions
    await page.getByRole("button", { name: "Bài tập" }).click();
    await page.getByTestId("generate-all-btn").click();
    // Inline generate form appears — click "Tạo tất cả" to proceed
    await page.getByRole("button", { name: "Tạo tất cả" }).click();
    await expect(page.getByRole("button", { name: "Đang tạo…" })).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="gen-done"], [data-testid="gen-error"]'),
    ).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-testid="gen-error"]')).not.toBeVisible();

    // Chunk cards with interactions visible in Bài tập tab
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 10_000 });
  });
});

// ── 5. Student quiz form ───────────────────────────────────────────────────

// Big-O seeded lesson checkpoint times (startSeconds per seed data)
const CHECKPOINT_SECONDS = [208, 416, 624, 831, 1039];

/** Answer all checkpoints via the video trigger hook, then return. */
async function answerAllCheckpoints(page: Page, optionIndexPerQ?: number[]) {
  for (let i = 0; i < CHECKPOINT_SECONDS.length; i++) {
    await triggerCheckpoint(page, CHECKPOINT_SECONDS[i] + 2);
    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 5_000 });
    const optIdx = optionIndexPerQ?.[i] ?? 0;
    await checkpoint.locator("button").nth(optIdx).click();
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 3_000 });
  }
}

test.describe("Student quiz form", () => {
  test("student sees quiz form (not correct answers)", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Bob has a seeded attempt → starts in result state
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();
    // Click Làm lại to reset to fresh state
    await page.getByRole("button", { name: "Làm lại" }).click();
    // In fresh state no checkpoint is active → no green borders visible
    await expect(page.locator(".border-green-500")).toHaveCount(0);
  });

  test("student sees previous attempt result (seeded)", async ({ studentPage: page }) => {
    // bob has a seeded attempt for Big-O lesson
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });

  test("student can retake quiz: answer all checkpoints + submit → new score", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();

    // "Nộp bài" should not appear until all checkpoints answered
    await expect(page.getByRole("button", { name: "Nộp bài" })).not.toBeVisible();

    await answerAllCheckpoints(page);

    const submitBtn = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn).toBeEnabled({ timeout: 3_000 });
    await submitBtn.click();

    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });

  test("submit button not visible until all questions answered via checkpoints", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();

    // Initially "Nộp bài" not visible
    await expect(page.getByRole("button", { name: "Nộp bài" })).not.toBeVisible();

    // Answer all but the last checkpoint
    for (let i = 0; i < CHECKPOINT_SECONDS.length - 1; i++) {
      await triggerCheckpoint(page, CHECKPOINT_SECONDS[i] + 2);
      const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
      await expect(checkpoint).toBeVisible({ timeout: 5_000 });
      await checkpoint.locator("button").first().click();
      await page.getByRole("button", { name: "Tiếp tục xem" }).click();
      await expect(checkpoint).not.toBeVisible({ timeout: 3_000 });
    }

    // After N-1 answered: "Nộp bài" still not visible
    await expect(page.getByRole("button", { name: "Nộp bài" })).not.toBeVisible();
  });

  test("after submit, correct answers revealed and Làm lại shown", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();

    // q1 correct_answer=1 per seed; others pick first option
    await answerAllCheckpoints(page, [1, 0, 0, 0, 0]);

    await page.getByRole("button", { name: "Nộp bài" }).click();

    // Correct answers revealed in LessonResult breakdown
    await expect(page.locator(".border-green-500").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });
});

// ── 6-8. Video checkpoint ──────────────────────────────────────────────────

test.describe("Video quiz checkpoint", () => {
  test("checkpoint appears when video reaches question start_seconds", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Bob has a seeded attempt → start in submitted state; reset first
    await page.getByRole("button", { name: "Làm lại" }).click();
    await expect(page.locator("video")).toBeVisible();

    // Trigger via test hook (Object.defineProperty on currentTime is unreliable in Firefox)
    await triggerCheckpoint(page, 210);

    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
  });

  test("clicking option in checkpoint shows correct/wrong feedback", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Bob has a seeded attempt (server reveals correct answers) → reset to trigger checkpoints
    await page.getByRole("button", { name: "Làm lại" }).click();
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);

    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });

    // Click any option — AFTER_SUBMIT mode shows acknowledgment (not green/red reveal)
    await checkpoint.locator("button").first().click();
    await expect(checkpoint.getByText("✓ Đã ghi nhận đáp án")).toBeVisible();
  });

  test("Tiếp tục xem dismisses checkpoint", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);

    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });
    // Must answer before "Tiếp tục xem" is enabled
    await checkpoint.locator("button").first().click();
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(checkpoint).not.toBeVisible();
  });

  test("checkpoint does not reappear for same question after dismiss", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();
    await expect(page.locator("video")).toBeVisible();

    // Trigger checkpoint
    await triggerCheckpoint(page, 210);
    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });
    await checkpoint.locator("button").first().click();
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(checkpoint).not.toBeVisible();

    // Trigger again at same time — checkpoint should NOT reappear (already in passedIds)
    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible();
  });

  test("teacher in editing mode does not see checkpoint", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);
    // Teacher in editing mode (effectiveCanManage=true) should NOT see quiz checkpoint
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible({ timeout: 2_000 });
  });

  test("teacher in preview mode sees checkpoint", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    await page.goto(`${lessonHref}?preview=1`);
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);
    // Teacher in preview mode (isPreview=true) behaves like a student — checkpoint is visible
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
  });

  test("student cannot bypass checkpoint by playing video while quiz shows", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });

    // Attempt to play via JS while quiz overlay is active
    await page.evaluate(() => {
      void (document.querySelector("video") as HTMLVideoElement | null)?.play();
    });
    await page.waitForTimeout(300);

    const paused = await page.evaluate(
      () => (document.querySelector("video") as HTMLVideoElement | null)?.paused ?? true,
    );
    expect(paused).toBe(true);
  });

  test("student cannot bypass checkpoint by seeking past it", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Làm lại" }).click();
    await expect(page.locator("video")).toBeVisible();

    await triggerCheckpoint(page, 210);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });

    // Seek to a time well past the checkpoint
    await page.evaluate(() => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (v) v.currentTime = 9999;
    });

    // Wait until seek protection resets currentTime
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        return !v || v.currentTime < 220;
      },
      { timeout: 5_000 },
    );

    const time = await page.evaluate(
      () => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? 0,
    );
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
    // Transcript is in the LessonSidebar — click the "Phiên âm" tab
    await page.getByRole("button", { name: "Phiên âm" }).click();
    // Plain text transcript (no interactive segments for seeded data)
    await expect(page.getByText(/Big-O notation/).first()).toBeVisible();
  });

  test("seek hint shown only when segments exist", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Seeded lesson has no transcript_segments → hint should NOT appear
    await expect(page.getByText("(nhấn vào đoạn để tua video)")).not.toBeVisible();
  });
});

// ── 4c. Full pipeline with audio fixture ─────────────────────────────────────
// Tests in this block require: edu-sample.mp4, Whisper + Gemini running in the
// test environment. They run serially so extraction happens only once, with the
// lesson URL shared across tests via a block-scoped variable.

test.describe.serial("Full pipeline with audio fixture (Whisper + Gemini)", () => {
  let lessonUrl = "";

  test("pipeline: upload audio video → extract → chunk → generate questions", async ({ teacherPage: page }) => {
    test.setTimeout(600_000);
    lessonUrl = await createLesson(
      page, uid("Pipeline Course"), uid("Pipeline Module"), uid("Pipeline Lesson"),
    );
    await page.goto(lessonUrl);
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // Step 1: Extract transcript
    await page.getByRole("button", { name: "Trích xuất transcript" }).click();
    await expect(page.getByRole("button", { name: "Đang trích xuất…" })).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: "Trích xuất lại transcript" }).or(page.locator('[data-testid="extract-error"]')),
    ).toBeVisible({ timeout: 360_000 });
    await expect(page.locator('[data-testid="extract-error"]')).not.toBeVisible();

    // Step 2: Chunk transcript
    await page.getByRole("button", { name: "Phân đoạn video" }).click();
    await page.getByRole("button", { name: "Phân đoạn lại" }).click();
    await expect(page.getByRole("button", { name: "Đang phân đoạn…" })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: "Phân đoạn lại" }).or(page.locator('[data-testid="chunk-error"]')),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('[data-testid="chunk-error"]')).not.toBeVisible();

    // Step 3: Generate questions
    await page.getByRole("button", { name: "Bài tập" }).click();
    await page.getByTestId("generate-all-btn").click();
    // Inline generate form appears — click "Tạo tất cả" to proceed
    await page.getByRole("button", { name: "Tạo tất cả" }).click();
    await expect(page.getByRole("button", { name: "Đang tạo…" })).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="gen-done"], [data-testid="gen-error"]'),
    ).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-testid="gen-error"]')).not.toBeVisible();
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 10_000 });
  });

  test("after pipeline: transcript segments visible with seek hint", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();
    await expect(page.getByText("Phiên âm nội dung")).toBeVisible();
    await expect(page.getByText("(nhấn vào đoạn để tua video)")).toBeVisible();
    await expect(page.locator('[data-testid="interactive-transcript"]')).toBeVisible();
    await expect(page.locator('[data-testid^="transcript-segment-"]').first()).toBeVisible();
  });

  test("after pipeline: clicking transcript segment seeks video", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();

    const firstSeg = page.locator('[data-testid="transcript-segment-0"]');
    await expect(firstSeg).toBeVisible({ timeout: 5_000 });

    const startSec = parseFloat((await firstSeg.getAttribute("data-start-seconds")) ?? "0");
    await firstSeg.click();

    const videoTime = await page.evaluate(
      () => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? -1,
    );
    expect(videoTime).toBeGreaterThanOrEqual(startSec - 0.5);
  });

  test("after pipeline: transcript chunks visible in Phân đoạn video tab", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();

    await page.getByRole("button", { name: "Phân đoạn video" }).click();
    // PipelineStep 1 "Phân đoạn lại" is collapsed after pipeline (defaultOpen={!hasChunks}=false).
    // Expand it first so children are rendered in the DOM.
    await page.getByLabel("Mở rộng").first().click();
    await expect(page.getByRole("button", { name: /Phân đoạn lại/ })).toBeVisible({ timeout: 5_000 });
  });

  test("after pipeline: status shows Hoàn thành", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();
    await expect(page.getByText("(Hoàn thành)")).toBeVisible({ timeout: 5_000 });
  });

  test("after pipeline: 'Trích xuất lại transcript' button visible when segments exist", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();
    // After pipeline, lesson has transcript segments → extract button shows "Trích xuất lại transcript"
    await expect(page.getByRole("button", { name: "Trích xuất lại transcript" })).toBeVisible({ timeout: 5_000 });
  });

  test("editing transcript segment updates VideoPlayer transcript display", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();

    // Pre-condition: interactive transcript is visible in VideoPlayer
    await expect(page.locator('[data-testid="interactive-transcript"]')).toBeVisible();

    // Open the "Phiên âm" tab in AnalyzeButton to access segment editing
    await page.getByRole("button", { name: "Phiên âm" }).click();
    await expect(page.locator('[data-testid="transcript-segment-0"]').first()).toBeVisible();

    // Edit the first segment
    const newText = `Đoạn đã sửa ${Date.now()}`;
    await page.getByTitle("Chỉnh sửa").first().click();
    const textarea = page.locator("textarea").first();
    await textarea.clear();
    await textarea.fill(newText);
    await page.getByTitle("Lưu").first().click();

    // After router.refresh(), VideoPlayer should show updated segment text
    await expect(page.locator('[data-testid="transcript-segment-0"]').first()).toContainText(newText, {
      timeout: 10_000,
    });
  });

  // NOTE: this test must run before "after video replacement" — the replacement
  // wipes chunks/transcript and resets status to PENDING, which locks the "Phân đoạn lại"
  // PipelineStep and hides the "Mở rộng" toggle button this test relies on.
  test("chunk step labels appear during ChunkTranscriptStream", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    test.setTimeout(300_000);
    // The pipeline lesson has a complete transcript — re-run chunking to observe progress labels.
    await page.goto(lessonUrl);
    await page.reload();

    // Navigate to "Phân đoạn video" tab where the "Phân đoạn lại" button lives
    await page.getByRole("button", { name: "Phân đoạn video" }).click();
    // PipelineStep 1 is collapsed after pipeline — expand it so the button is in the DOM
    await page.getByLabel("Mở rộng").first().click();
    await page.getByRole("button", { name: "Phân đoạn lại" }).click();

    const chunkPanel = page.locator('[data-testid="chunk-progress"]');
    await expect(chunkPanel).toBeVisible({ timeout: 10_000 });
    await expect(chunkPanel.getByText("Phân tích nội dung với Gemini")).toBeVisible();
    await expect(chunkPanel.getByText("Lưu các đoạn")).toBeVisible();

    // Wait for the re-chunk to actually finish so subsequent tests in this block
    // see chunks (not an empty list during the in-flight ChunkTranscriptStream).
    await expect(page.getByRole("button", { name: "Phân đoạn lại" })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('[data-testid="chunk-error"]')).not.toBeVisible();
  });

  // Regression test for the Vietnamese-coherence bug: before the fix, the
  // CoherenceBadge always read 0% (or under 30%) for VN audio because the regex
  // didn't match Latin Extended Additional diacritics. This test runs after the
  // real Whisper+Gemini pipeline and asserts that at least one chunk shows
  // a non-zero coherence percentage.
  test("after pipeline: CoherenceBadge renders a valid % for every chunk", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    await page.goto(lessonUrl);
    await page.reload();

    // After redesign: "Phân đoạn video" tab has 2 steps, both collapsible (default closed).
    // Step 2 "Chỉnh sửa đoạn" contains the CoherenceBadge. Expand both.
    await page.getByRole("button", { name: "Phân đoạn video" }).click();
    // Expand Step 2: the second "Mở rộng" button (Step 1 is also collapsible)
    const expandButtons = page.getByLabel("Mở rộng");
    await expect(expandButtons.nth(1)).toBeVisible({ timeout: 5_000 });
    await expandButtons.nth(1).click();

    const badges = page.getByTestId("coherence-badge");
    await expect(badges.first()).toBeVisible({ timeout: 10_000 });

    const count = await badges.count();
    expect(count).toBeGreaterThan(0);

    let maxScore = 0;
    for (let i = 0; i < count; i++) {
      const raw = await badges.nth(i).getAttribute("data-score");
      expect(raw, `badge ${i} missing data-score`).not.toBeNull();
      const score = parseInt(raw!, 10);
      expect(Number.isFinite(score), `badge ${i} score must be a number`).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      // Rendered text matches the attribute → no rounding mismatch.
      await expect(badges.nth(i)).toHaveText(`${score}%`);
      if (score > maxScore) maxScore = score;
    }

    // Bug fix verification: pre-fix every chunk read 0% because the regex
    // dropped most VN tokens. Any non-zero value confirms the new formula
    // (Unicode \p{L} tokenization + stopwords + lexical-chain + overlap)
    // is reaching real content.
    expect(maxScore, "all chunks read 0% — coherence regression").toBeGreaterThan(0);
  });

  test("after video replacement: transcript state and VideoPlayer clear", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    test.setTimeout(60_000);
    await page.goto(lessonUrl);
    await page.reload();

    // Pre-condition: pipeline ran → transcript sections are visible
    await expect(page.getByText("Phiên âm nội dung")).toBeVisible();
    await expect(page.locator('[data-testid="interactive-transcript"]')).toBeVisible();

    // Upload a replacement video (same format, triggers status → PENDING)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    await expect(page.getByText("Video đã được tải lên thành công")).toBeVisible({ timeout: 30_000 });

    // After replacement: VideoPlayer transcript section should disappear (status → PENDING, FDB cleared)
    await expect(page.getByText("Phiên âm nội dung")).not.toBeVisible({ timeout: 10_000 });

    // AnalyzeButton state reset: button reverts to "Trích xuất transcript" (not "Trích xuất lại transcript")
    await expect(page.getByRole("button", { name: "Trích xuất transcript" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trích xuất lại transcript" })).not.toBeVisible();
  });
});

// ── 11. Teacher question editing ──────────────────────────────────────────────

test.describe("Teacher question editing (seeded data)", () => {
  test("teacher sees edit/delete buttons on each question", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Bài tập" }).click();
    // After redesign: chunk-based layout with per-chunk interaction cards
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5000 });

    // First question row should have edit and delete icons
    await expect(page.getByTitle("Chỉnh sửa").first()).toBeVisible();
    await expect(page.getByTitle("Xóa").first()).toBeVisible();
  });

  test("teacher can edit a question inline", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Bài tập" }).click();
    // After redesign: chunk-based layout with per-chunk interaction cards
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5000 });

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
    await page.getByRole("button", { name: "Bài tập" }).click();
    // After redesign: chunk-based layout with per-chunk interaction cards
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5000 });

    await page.getByTestId("add-interaction-btn").first().click();
    // Inline form opens with MCQ selected by default — click "Trắc nghiệm" to confirm kind
    await page.getByRole("button", { name: "Trắc nghiệm" }).click();

    // Fill in the add form — after selecting kind, InteractionForm appears
    await page.getByPlaceholder("Nhập câu hỏi...").fill("Câu hỏi thủ công mới");
    const optionInputs = page.locator('input[type="text"]');
    await optionInputs.nth(0).fill("Phương án A");
    await optionInputs.nth(1).fill("Phương án B");
    await optionInputs.nth(2).fill("Phương án C");
    await optionInputs.nth(3).fill("Phương án D");

    await page.getByRole("button", { name: "Lưu" }).last().click();
    await expect(page.getByText("Câu hỏi thủ công mới").first()).toBeVisible({ timeout: 5_000 });
  });

  test("bug 1.8: adding 3 questions consecutively keeps all of them visible", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Bài tập" }).click();
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5_000 });

    const stamp = Date.now();
    const q = (n: number) => `Bug18-${n}-${stamp}`;

    async function addMcq(question: string) {
      await page.getByTestId("add-interaction-btn").first().click();
      await page.getByPlaceholder("Nhập câu hỏi...").fill(question);
      const opts = page.locator('input[type="text"]');
      await opts.nth(0).fill("A");
      await opts.nth(1).fill("B");
      await opts.nth(2).fill("C");
      await opts.nth(3).fill("D");
      await page.getByRole("button", { name: "Lưu" }).last().click();
      // Wait for form to close
      await expect(page.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 5_000 });
    }

    await addMcq(q(1));
    await expect(page.getByText(q(1))).toBeVisible({ timeout: 5_000 });

    await addMcq(q(2));
    // Both questions must be visible — regression: stale closure would drop q(1)
    await expect(page.getByText(q(1))).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(q(2))).toBeVisible({ timeout: 5_000 });

    await addMcq(q(3));
    await expect(page.getByText(q(1))).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(q(2))).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(q(3))).toBeVisible({ timeout: 5_000 });
  });

  test("teacher can delete a question", async ({ teacherPage: page }) => {
    // Navigate to the Big-O lesson to get the editable question list
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Bài tập" }).click();
    // After redesign: chunk-based layout with per-chunk interaction cards
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5000 });

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
    // Bob has a seeded attempt → sees result; no edit/delete controls in student view
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();
    await expect(page.getByTitle("Chỉnh sửa")).not.toBeVisible();
    await expect(page.getByTitle("Xóa")).not.toBeVisible();
  });

  test("teacher in preview mode does not see edit/delete buttons", async ({ teacherPage: page }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await page.goto(`${href}?preview=1`);
    // In preview mode teacher sees StudentLessonView (no edit controls)
    await expect(page.locator('[data-testid="video-player"]')).toBeVisible();
    await expect(page.getByTitle("Chỉnh sửa")).not.toBeVisible();
    await expect(page.getByTitle("Xóa")).not.toBeVisible();
  });

  test("cancel edit discards changes", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await page.getByRole("button", { name: "Bài tập" }).click();
    // After redesign: chunk-based layout with per-chunk interaction cards
    await expect(page.getByText(/\d+ bài tập/).first()).toBeVisible({ timeout: 5000 });

    // Open edit first to read the original question text from the textarea
    await page.getByTitle("Chỉnh sửa").first().click();
    const textarea = page.locator("textarea").first();
    const questionText = await textarea.inputValue();
    await textarea.fill("Đây là thay đổi bị hủy");
    await page.getByRole("button", { name: "Hủy" }).first().click();

    // Original text still shown
    await expect(page.getByText(questionText ?? "")).toBeVisible();
    await expect(page.getByText("Đây là thay đổi bị hủy")).not.toBeVisible();
  });
});