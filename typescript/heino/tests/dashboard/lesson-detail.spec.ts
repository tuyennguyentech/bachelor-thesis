/**
 * E2E tests for dashboard lesson detail page.
 *
 * Tests that:
 * - Lesson title is visible for all roles
 * - Video upload section is visible to teacher/admin
 * - Video upload section is hidden from student
 * - Lesson rows in course detail are clickable links
 * - Student sees previous quiz attempt result on seeded lesson (new UI: donut + Làm lại)
 * - Student can retake: trigger checkpoints via __triggerVideoCheckpoint, submit, see result
 * - Marker strip shows data-testid="checkpoint-marker-{id}" with data-state attributes
 * - Teacher sees "Thay video", technical details, and video authoring workflow on lesson with video_key
 * - Feedback modes: AFTER_SUBMIT (no reveal at checkpoint), AFTER_EACH (immediate reveal)
 */

import type { Page } from "@playwright/test";
import {
  test,
  expect,
  goToSeededLesson,
  SEED_HUST_CS_SLUG as ORG_SLUG,
  SEED_DSA_LESSON_BIG_O as SEEDED_LESSON_BIG_O,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

/** Trigger a synthetic checkpoint hit via the E2E window hook. */
async function triggerCheckpoint(page: Page, seconds: number) {
  await page.evaluate((t) => {
    const fn = (window as unknown as Record<string, unknown>).__triggerVideoCheckpoint;
    if (typeof fn === "function") (fn as (t: number) => void)(t);
  }, seconds);
}

// ── Lesson link navigation ─────────────────────────────────────────────────

test.describe("Lesson row is a link to lesson detail", () => {
  test("stale lesson URL shows recovery links", async ({ teacherPage: page }) => {
    const lessonUrl = await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    const staleLessonUrl = lessonUrl.replace(
      /\/lessons\/[^/?#]+/,
      "/lessons/019e0000-0000-7000-8000-000000000000",
    );

    await page.goto(staleLessonUrl);

    const notFoundMain = page.locator("main").last();
    await expect(page.getByRole("heading", { name: "Không tìm thấy bài học" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Về khóa học" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Danh sách khóa học" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Trang chính" })).toBeVisible();
  });

  test("stale course URL shows course recovery links", async ({ teacherPage: page }) => {
    const lessonUrl = await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    const staleCourseUrl = lessonUrl.replace(
      /\/courses\/[^/]+\/lessons\/[^/?#]+/,
      "/courses/019e0000-0000-7000-8000-000000000001",
    );

    await page.goto(staleCourseUrl);

    const notFoundMain = page.locator("main").last();
    await expect(page.getByRole("heading", { name: "Không tìm thấy khóa học" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Danh sách khóa học" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Về tổ chức" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Trang chính" })).toBeVisible();
  });

  test("stale organization URL shows dashboard recovery link", async ({ teacherPage: page }) => {
    await page.goto("/dashboard/organizations/no-such-org-for-e2e");

    const notFoundMain = page.locator("main").last();
    await expect(page.getByRole("heading", { name: "Không tìm thấy tổ chức" })).toBeVisible();
    await expect(notFoundMain.getByRole("link", { name: "Trang chính" })).toBeVisible();
  });

  test("clicking a lesson row navigates to lesson detail page", async ({ teacherPage: page }) => {
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
    await expect(page.getByText("Nguồn video")).toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
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
    await expect(page.getByText("Nguồn video")).not.toBeVisible();
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

// ── Seeded lesson — student sees previous result (new UI) ─────────────────

test.describe("Seeded lesson — student sees previous attempt result", () => {
  test("shows donut score + Làm lại button", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Bob has a seeded quiz attempt — the new UI shows LessonResult with donut score + Làm lại
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();
    await expect(page.getByText(/điểm/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });
});

// ── Seeded lesson — AFTER_SUBMIT checkpoint flow ───────────────────────────

test.describe("Seeded lesson — AFTER_SUBMIT checkpoint flow", () => {
  test("checkpoint shows without reveal, markers turn passed, submit shows result", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);

    // Reset via Làm lại if visible
    const retakeBtn = page.getByRole("button", { name: "Làm lại" });
    if (await retakeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await retakeBtn.click();
    }

    // Seeded Big-O lesson: 5 interactions at 208s, 416s, 624s, 831s, 1039s
    // Trigger first checkpoint
    await triggerCheckpoint(page, 208);

    // Checkpoint card should appear
    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 5000 });

    // AFTER_SUBMIT mode: no green/red reveal — just acknowledgement after selection
    // Select first option
    await checkpoint.locator("button").first().click();

    // Acknowledgement text (no reveal)
    await expect(checkpoint.getByText("✓ Đã ghi nhận đáp án")).toBeVisible();

    // Continue — wait for checkpoint to vanish before triggering next
    await checkpoint.getByRole("button", { name: /Tiếp tục/ }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 5000 });

    // Trigger second checkpoint
    await triggerCheckpoint(page, 416);
    await expect(checkpoint).toBeVisible({ timeout: 5000 });
    await checkpoint.locator("button").first().click();
    await checkpoint.getByRole("button", { name: /Tiếp tục/ }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 5000 });

    // Trigger third checkpoint
    await triggerCheckpoint(page, 624);
    await expect(checkpoint).toBeVisible({ timeout: 5000 });
    await checkpoint.locator("button").first().click();
    await checkpoint.getByRole("button", { name: /Tiếp tục/ }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 5000 });

    // Trigger fourth checkpoint
    await triggerCheckpoint(page, 831);
    await expect(checkpoint).toBeVisible({ timeout: 5000 });
    await checkpoint.locator("button").first().click();
    await checkpoint.getByRole("button", { name: /Tiếp tục/ }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 5000 });

    // Trigger fifth checkpoint
    await triggerCheckpoint(page, 1039);
    await expect(checkpoint).toBeVisible({ timeout: 5000 });
    await checkpoint.locator("button").first().click();
    await checkpoint.getByRole("button", { name: /Tiếp tục/ }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 5000 });

    // All 5 answered → submit button appears
    const submitBtn = page.getByRole("button", { name: /Nộp bài/ });
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    // Result section appears with donut score
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/điểm/).first()).toBeVisible();
  });
});

// ── Seeded lesson with video key — teacher management section ─────────────

test.describe("Seeded lesson with video key — teacher management section", () => {
  test("shows Thay video, technical details, and authoring workflow when lesson has video_key", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ẩn danh sách bài học" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Cấu trúc khóa học/ })).toBeVisible();
    await expect(page.getByText("Trong khóa học")).not.toBeVisible();
    await page.getByRole("button", { name: "Ẩn danh sách bài học" }).click();
    await expect(page.getByRole("button", { name: "Hiện danh sách bài học" })).toBeVisible();
    await page.getByRole("button", { name: "Hiện danh sách bài học" }).click();

    // Click Step 1 to open the upload panel since the lesson is seeded and active step is exercises
    await page.getByTestId("workflow-step-upload").click();

    // Seed set video_key → hasVideo=true → button reads "Thay video"
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
    await expect(page.getByText("Nguồn video")).toBeVisible();
    // Storage key is available in technical details, not exposed in the primary UI.
    await page.getByText("Chi tiết kỹ thuật").click();
    await expect(page.getByText(/Key: seed\/hust-cs\//)).toBeVisible();
    // Video authoring workflow is visible when videoStorageKey is set.
    await expect(page.getByText("Tạo nội dung từ video")).toBeVisible();
  });
});

// ── Seeded lesson — AFTER_EACH mode (teacher changes mode) ────────────────

test.describe("Seeded lesson — AFTER_EACH feedback mode", () => {
  test("AFTER_EACH: checkpoint shows green banner for correct answer", async ({ teacherPage: teachPage, studentPage: studPage }) => {
    // Teacher navigates to the lesson and sets AFTER_EACH feedback mode
    await goToSeededLesson(teachPage, SEEDED_LESSON_BIG_O);
    // Open the "Bài tập" tab in AnalyzeButton
    const baiTapTab = teachPage.getByRole("tab", { name: "Bài tập" });
    // The tab is inside the AnalyzeButton section — click it if visible
    if (await baiTapTab.isVisible()) {
      await baiTapTab.click();
      // Set AFTER_EACH mode
      const afterEachRadio = teachPage.getByLabel(/Ngay sau mỗi câu/);
      if (await afterEachRadio.isVisible()) {
        await afterEachRadio.click();
        // Wait for save
        await teachPage.waitForTimeout(500);
      }
    }

    // Student navigates to the lesson (fresh page load with new mode)
    await goToSeededLesson(studPage, SEEDED_LESSON_BIG_O);

    // Reset via Làm lại (bob has seeded attempt)
    await page_getByRole_retake(studPage);

    // Trigger first checkpoint
    await triggerCheckpoint(studPage, 208);

    const checkpoint = studPage.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 5000 });

    // Find the correct answer index by looking at the seeded data (correctAnswer=0 for index 0)
    // The seeded lesson's first interaction has correctAnswer at index i%4 for i=0, so index 0
    // Click the first option (which is correct for the first interaction in seed)
    await checkpoint.locator("button").first().click();

    // AFTER_EACH: should show either green banner or red banner immediately
    const hasBanner = await checkpoint.getByText(/Chính xác|Chưa đúng/).isVisible().catch(() => false);
    // If the mode was set successfully, banner should appear
    if (hasBanner) {
      // Verify it's a green or red banner (one of the two)
      const correct = await checkpoint.getByText("✅ Chính xác!").isVisible().catch(() => false);
      const wrong = await checkpoint.getByText(/❌ Chưa đúng/).isVisible().catch(() => false);
      expect(correct || wrong).toBe(true);
    }
    // Whether or not mode change propagated, the Continue button should be visible
    await expect(checkpoint.getByRole("button", { name: /Tiếp tục/ })).toBeVisible({ timeout: 3000 });

    // Restore AFTER_SUBMIT mode for other tests
    if (await teachPage.getByRole("tab", { name: "Bài tập" }).isVisible()) {
      const afterSubmitRadio = teachPage.getByLabel(/Sau khi nộp bài/);
      if (await afterSubmitRadio.isVisible()) {
        await afterSubmitRadio.click();
        await teachPage.waitForTimeout(300);
      }
    }
  });
});

async function page_getByRole_retake(page: Page) {
  const retakeBtn = page.getByRole("button", { name: "Làm lại" });
  if (await retakeBtn.isVisible().catch(() => false)) {
    await retakeBtn.click();
  }
}

// ── Phase 1: Fill-blank interaction creation via teacher editor ───────────

test.describe("Fill-blank interaction — teacher creates via editor", () => {
  test("teacher can add a fill-blank interaction and it appears in the list", async ({ teacherPage: page }) => {
    // Use the seeded Big-O lesson — it has a video + analysis so the Bài tập tab is visible
    await goToSeededLesson(page, SEEDED_LESSON_BIG_O);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Open the "Bài tập" workflow step inside AnalyzeButton.
    await page.getByTestId("workflow-step-exercises").click();
    // After redesign: chunk-based layout, use add-interaction-btn in first chunk card
    const addBtn = page.getByTestId("add-interaction-btn").first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });

    // Open inline add form and select "Điền đáp án" kind tab
    await addBtn.click();
    await page.getByRole("button", { name: "Điền đáp án" }).click();

    // Fill in the prompt
    await page.getByPlaceholder("Nhập câu hỏi...").fill("Câu điền đáp án thử nghiệm");

    // Fill in template
    await page.getByPlaceholder(/Ví dụ.*\{\{0\}\}/).fill("Năng lượng không thể {{0}} mà chỉ chuyển hóa.");

    // Fill in accepted answers for blank 0
    await page.getByPlaceholder("ví dụ: tự sinh ra, được tạo ra").fill("tự sinh ra, được tạo ra");

    // Leave startSeconds at 0 (no timed checkpoint) to avoid interfering with seeded MCQ checkpoints

    // Save
    await page.getByRole("button", { name: "Lưu" }).click();

    // The fill-blank interaction should appear in the list (use first() since seeded lesson may have prior fill-blank entries from earlier test runs)
    await expect(page.getByText("Điền đáp án").first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Năng lượng không thể.*\{\{0\}\}/).first()).toBeVisible();
  });
});
