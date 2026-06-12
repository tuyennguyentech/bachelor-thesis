/**
 * E2E tests for the "Bài viết" (Writing) interaction kind — a teacher-authored,
 * AI-graded essay question.
 *
 * Coverage:
 * - Teacher creates a Writing interaction via the manual per-chunk add form
 *   (mirrors the fill-blank "teacher creates via editor" pattern) and it appears
 *   in the interaction list.
 * - Student opens a lesson that HAS a writing interaction, sees the essay
 *   textarea (writing-student-textarea), types an essay, submits, and the submit
 *   flow completes (post-submit confirmation + Continue button surface).
 *
 * AI grading (Gemini) is NOT configured in the test env, so the handler returns
 * a PENDING fallback. These tests therefore assert that the submit flow COMPLETES
 * and a result/feedback appears — they do NOT assert a specific AI score.
 */

import {
  test,
  expect,
  uid,
  createAnalyzedLesson,
  createInteraction,
  loginAs,
  getUserId,
  addCourseMember,
  CourseRole,
  STUDENT_EMAIL,
  USER_PASSWORD,
  SEED_HUST_CS_SLUG,
  InteractionKind,
} from "../fixtures";
import type { Locator } from "@playwright/test";

// ── TASK: Writing interaction — teacher creates via editor ──────────────────

test.describe("Writing interaction — teacher creates via editor", () => {
  test("teacher can add a writing interaction and it appears in the list", async ({ teacherPage: page, baseURL }) => {
    // Mirrors the fill-blank "teacher creates via editor" test. The extract+chunk
    // pipeline is seeded via createAnalyzedLesson (no real Whisper/Gemini), which
    // provisions a fresh teacher + course (with chunks + succeeded tasks) and adds
    // carol (the teacherPage user) as a course teacher, so the exercises step is
    // reliably enabled.
    test.setTimeout(180_000);

    const { lessonUrl } = await createAnalyzedLesson(baseURL);
    const url = lessonUrl.split("?")[0];

    // Open the processing tab — deriveAnalysisFromTasks returns ChunksReady,
    // so the exercises step is enabled.
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Confirm the exercises step is active and the add button is enabled
    // (signals full React hydration), then open the inline add form.
    await expect(page.getByTestId("workflow-step-exercises")).toHaveAttribute(
      "aria-current", "step", { timeout: 15_000 },
    );
    const addBtn = page.getByTestId("add-interaction-btn").first();
    await expect(addBtn).toBeEnabled({ timeout: 15_000 });

    // Retry the open like studio-new-interactions does: under load Firefox can
    // drop the click while the tree is still settling.
    let form: Locator = page.getByTestId("chunk-add-form").last();
    let visible = false;
    for (let attempt = 0; attempt < 5 && !visible; attempt++) {
      await addBtn.click();
      form = page.getByTestId("chunk-add-form").last();
      visible = await form.isVisible().catch(() => false);
      if (!visible) await page.waitForTimeout(500 * (attempt + 1));
    }
    await expect(form).toBeVisible({ timeout: 10_000 });

    // Select the "Bài viết" / "Viết" kind (InteractionKind.WRITING = 6).
    await form.getByTestId(`interaction-kind-${InteractionKind.WRITING}`).click({ force: true });

    // The writing editor (testid "writing-editor") replaces the generic prompt
    // textarea; its "Đề bài" textarea is the required prompt source.
    const editor = form.getByTestId("writing-editor");
    await expect(editor).toBeVisible({ timeout: 10_000 });

    const writingPrompt = `Hãy viết một đoạn văn về chủ đề học tập ${uid("")}`;
    await editor.getByTestId("writing-editor-prompt").fill(writingPrompt);

    // Optional fields: rubric, model answer, minimum words.
    await editor.getByPlaceholder(/bố cục rõ ràng/).fill("Bố cục rõ ràng, lập luận thuyết phục.");
    await editor.getByPlaceholder(/Bài viết mẫu/).fill("Đây là một bài viết mẫu tham khảo.");
    await editor.locator('input[type="number"]').fill("20");

    // Set start time and save.
    await form.locator('input[type="number"]').last().fill("3");
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });

    // The writing interaction should appear in the interaction list. Scope to
    // interaction-row so we don't match the same prompt in the hidden video
    // checkpoint overlay (the content tab stays mounted but CSS-hidden).
    await expect(page.getByTestId("interaction-row").filter({ hasText: writingPrompt }).first())
      .toBeVisible({ timeout: 10_000 });
    // The kind label "Bài viết" is rendered on the row badge.
    await expect(page.getByTestId("interaction-row").filter({ hasText: writingPrompt }).first()
      .getByText("Bài viết")).toBeVisible({ timeout: 5_000 });
  });
});

// ── TASK: Writing interaction — student submits an essay ────────────────────

test.describe("Writing interaction — student submits", () => {
  test("student can write an essay, submit it, and see a result", async ({ page, baseURL }) => {
    test.setTimeout(180_000);

    // Provision a fresh analyzed lesson (fresh teacher/course/lesson + chunks),
    // then seed a Writing interaction on it via API at a known checkpoint time.
    const { lessonId, courseId, token } = await createAnalyzedLesson(baseURL);

    const startSeconds = 3;
    const writingPrompt = `Viết về một ngày đáng nhớ ${uid("")}`;
    await createInteraction(
      token,
      lessonId,
      {
        kind: InteractionKind.WRITING,
        startSeconds,
        prompt: writingPrompt,
        config: {
          case: "writing",
          value: {
            prompt: writingPrompt,
            rubric: "Diễn đạt mạch lạc.",
            expectedAnswer: "",
            minWords: 5,
          },
        },
      },
      baseURL,
    );

    // The lesson lives in a freshly-created course, so the student must be
    // enrolled before the course-access gate will let them open it.
    const studentId = await getUserId(STUDENT_EMAIL, USER_PASSWORD, baseURL);
    await addCourseMember(token, courseId, studentId, CourseRole.STUDENT, baseURL);

    // Log in as a real student and open the lesson (student learning view).
    await loginAs(page, STUDENT_EMAIL, USER_PASSWORD, baseURL);
    const lessonUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}/lessons/${lessonId}`;
    await page.goto(lessonUrl, { waitUntil: "domcontentloaded" });

    // Wait for the video player to mount the checkpoint trigger hook.
    await page.waitForFunction(() => "__triggerVideoCheckpoint" in window, { timeout: 15_000 });

    // If a previous attempt exists, reset it.
    const retakeBtn = page.getByRole("button", { name: "Làm lại" });
    if (await retakeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await retakeBtn.click({ force: true });
    }

    // Trigger the checkpoint at the writing interaction's start time.
    await page.evaluate((s) => {
      (window as unknown as { __triggerVideoCheckpoint: (s: number) => void }).__triggerVideoCheckpoint(s);
    }, startSeconds + 0.5);

    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 10_000 });

    // The writing student view (textarea) should be surfaced inside the checkpoint.
    const textarea = checkpoint.getByTestId("writing-student-textarea");
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await expect(textarea).toBeEditable();

    // Type an essay that meets the 5-word minimum.
    await textarea.fill("Đây là một bài viết thử nghiệm cho luồng nộp bài.");

    // Submit.
    const submitBtn = checkpoint.getByTestId("writing-submit");
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click({ force: true });

    // AI grading is not configured → PENDING fallback. Assert the submit flow
    // COMPLETES: post-submit confirmation appears AND the Continue button surfaces.
    // Do NOT assert a specific AI score.
    await expect(checkpoint.getByText(/Đã nộp bài viết/)).toBeVisible({ timeout: 15_000 });
    await expect(
      checkpoint.getByRole("button", { name: /Tiếp tục xem|Câu tiếp theo/ }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
