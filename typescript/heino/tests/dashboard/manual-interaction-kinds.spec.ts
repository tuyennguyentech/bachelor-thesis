/**
 * E2E: teacher manually creates an exercise of EVERY kind for a chunk via the
 * per-chunk add form ("Thêm bài tập" → chunk-add-form).
 *
 * Motivation: the manual add form (chunk-add-form.tsx) exposes all six interaction
 * kinds (interaction-kind-1..6), but only WRITING had E2E coverage
 * (writing-interaction.spec.ts). This test exercises the full authoring path for
 * every kind — pick the type, fill the per-kind editor's required fields, save,
 * and assert the interaction appears in the list — so a regression in any single
 * kind's editor / save path is caught.
 *
 * All six kinds are created on ONE analyzed lesson (createAnalyzedLesson provisions
 * a fresh teacher + course with chunks + succeeded tasks, so the exercises step is
 * enabled). LISTENING synthesises audio from its source text via Piper TTS on save,
 * so its assertion allows extra time.
 */
import { test, expect, uid, createAnalyzedLesson, InteractionKind } from "../fixtures";
import type { Page, Locator } from "@playwright/test";

// Open the inline per-chunk add form on the first chunk. Retries the click like
// the other create-flow specs: under load Firefox can drop it while the tree is
// still settling.
async function openAddForm(page: Page): Promise<Locator> {
  const addBtn = page.getByTestId("add-interaction-btn").first();
  await expect(addBtn).toBeEnabled({ timeout: 15_000 });
  let form: Locator = page.getByTestId("chunk-add-form").last();
  let visible = false;
  for (let attempt = 0; attempt < 5 && !visible; attempt++) {
    await addBtn.click();
    form = page.getByTestId("chunk-add-form").last();
    visible = await form.isVisible().catch(() => false);
    if (!visible) await page.waitForTimeout(500 * (attempt + 1));
  }
  await expect(form).toBeVisible({ timeout: 10_000 });
  return form;
}

// Fill the generic top-level prompt textarea (present for every kind except
// WRITING, whose prompt lives in its own editor). Its placeholder is exactly
// "Nhập câu hỏi..." — anchored so it does NOT collide with the LISTENING source
// textarea ("Nhập câu hỏi. Học viên sẽ nghe…").
async function fillTopPrompt(form: Locator, text: string) {
  await form.getByPlaceholder(/^Nhập câu hỏi\.\.\.$/).fill(text);
}

async function save(form: Locator) {
  const saveBtn = form.getByRole("button", { name: "Lưu" });
  await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
  await saveBtn.click({ force: true });
}

// Assert an interaction row carrying `prompt` surfaced. Scoped to interaction-row
// so we don't match the same text in the (mounted-but-hidden) video checkpoint
// overlay on the content tab.
async function expectRow(page: Page, prompt: string, timeout = 15_000) {
  await expect(
    page.getByTestId("interaction-row").filter({ hasText: prompt }).first(),
  ).toBeVisible({ timeout });
}

test.describe("Manual per-chunk exercise creation — all kinds", () => {
  test("teacher can add an exercise of every kind via the add form", async ({ teacherPage: page, baseURL }) => {
    // Real analyzed lesson + all six kinds (LISTENING synthesises TTS on save).
    test.setTimeout(300_000);

    const { lessonUrl } = await createAnalyzedLesson(baseURL);
    const url = lessonUrl.split("?")[0];
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("workflow-step-exercises")).toHaveAttribute(
      "aria-current", "step", { timeout: 15_000 },
    );

    // ── 1) SINGLE_CHOICE ─────────────────────────────────────────────────────
    {
      const prompt = `Trắc nghiệm một đáp án ${uid("")}`;
      const form = await openAddForm(page);
      await form.getByTestId(`interaction-kind-${InteractionKind.SINGLE_CHOICE}`).click({ force: true });
      await fillTopPrompt(form, prompt);
      await form.getByPlaceholder("Lựa chọn A").fill("Hà Nội");
      await form.getByPlaceholder("Lựa chọn B").fill("Huế");
      await form.getByPlaceholder("Lựa chọn C").fill("Đà Nẵng");
      await form.getByPlaceholder("Lựa chọn D").fill("Hồ Chí Minh");
      // Single choice no longer auto-marks option A — the teacher must pick one (the
      // server rejects correct_answer < 0), so explicitly mark A as the correct answer.
      await form.getByTitle("Chọn làm đáp án đúng").first().click({ force: true });
      await save(form);
      await expectRow(page, prompt);
    }

    // ── 2) MULTIPLE_CHOICE ───────────────────────────────────────────────────
    {
      const prompt = `Trắc nghiệm chọn nhiều ${uid("")}`;
      const form = await openAddForm(page);
      await form.getByTestId(`interaction-kind-${InteractionKind.MULTIPLE_CHOICE}`).click({ force: true });
      await fillTopPrompt(form, prompt);
      await form.getByPlaceholder("Lựa chọn A").fill("2");
      await form.getByPlaceholder("Lựa chọn B").fill("3");
      await form.getByPlaceholder("Lựa chọn C").fill("5");
      await form.getByPlaceholder("Lựa chọn D").fill("7");
      // Mark a second correct answer too (default already has the first correct);
      // the toggle button exposes its intent via title.
      await form.getByTitle("Chọn làm đáp án đúng").first().click({ force: true });
      await save(form);
      await expectRow(page, prompt);
    }

    // ── 3) FILL_BLANK ────────────────────────────────────────────────────────
    {
      const prompt = `Điền đáp án ${uid("")}`;
      const form = await openAddForm(page);
      await form.getByTestId(`interaction-kind-${InteractionKind.FILL_BLANK}`).click({ force: true });
      await fillTopPrompt(form, prompt);
      // Typing a {{0}} token derives blank #0; its "accepted answers" field then
      // appears and must be filled for the form to be saveable.
      await form.getByPlaceholder(/Năng lượng không thể/).fill("Nước sôi ở {{0}} độ C.");
      await form.getByPlaceholder(/tự sinh ra/).fill("100, một trăm");
      await save(form);
      await expectRow(page, prompt);
    }

    // ── 4) READING ───────────────────────────────────────────────────────────
    {
      const prompt = `Bài đọc ${uid("")}`;
      const form = await openAddForm(page);
      await form.getByTestId(`interaction-kind-${InteractionKind.READING}`).click({ force: true });
      await fillTopPrompt(form, prompt);
      await form
        .getByPlaceholder(/Nhập đoạn văn bản/)
        .fill("Mặt trời mọc ở hướng đông và lặn ở hướng tây mỗi ngày.");
      await save(form);
      await expectRow(page, prompt);
    }

    // ── 5) WRITING ───────────────────────────────────────────────────────────
    {
      const prompt = `Bài viết ${uid("")}`;
      const form = await openAddForm(page);
      await form.getByTestId(`interaction-kind-${InteractionKind.WRITING}`).click({ force: true });
      // WRITING hides the generic prompt; its prompt is the editor's "Đề bài".
      const editor = form.getByTestId("writing-editor");
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await editor.getByTestId("writing-editor-prompt").fill(prompt);
      await save(form);
      await expectRow(page, prompt);
    }

    // ── 6) LISTENING (audio synthesised from source text on save) ────────────
    {
      const prompt = `Bài nghe ${uid("")}`;
      const form = await openAddForm(page);
      await form.getByTestId(`interaction-kind-${InteractionKind.LISTENING}`).click({ force: true });
      await fillTopPrompt(form, prompt);
      // The audio IS the question: the learner hears this text, then answers the
      // comprehension MCQ. Fill the source text + all four comprehension options.
      // The nested-mcq EDITOR reuses the same "Lựa chọn A/B/C/D" option placeholders
      // as the plain MCQ editor (the nested-mcq-*-option-* testid is student-view only).
      await form.getByPlaceholder(/Học viên sẽ nghe/).fill("Thủ đô của Việt Nam là thành phố nào?");
      await form.getByPlaceholder("Lựa chọn A").fill("Hà Nội");
      await form.getByPlaceholder("Lựa chọn B").fill("Huế");
      await form.getByPlaceholder("Lựa chọn C").fill("Đà Nẵng");
      await form.getByPlaceholder("Lựa chọn D").fill("Hồ Chí Minh");
      // Listening's comprehension MCQ no longer auto-marks option A — pick the correct
      // answer explicitly (else the nested MCQ has correctAnswer=-1 and save is rejected).
      await form.getByTitle("Chọn làm đáp án đúng").first().click({ force: true });
      await save(form);
      // Save synthesises audio via Piper TTS, so allow extra time.
      await expectRow(page, prompt, 45_000);
    }
  });

  // Repro for the reported bug (#10 multiple-choice, #11 listening): a FRESH exercise
  // pre-marked option A as the correct answer. It must open with NO answer marked — the
  // teacher picks. Asserts the DEFAULT state directly (data-correct), rather than working
  // around it by clicking a correct answer first.
  test("no correct answer is pre-marked by default (single / multiple / listening)", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    const { lessonUrl } = await createAnalyzedLesson(baseURL);
    const url = lessonUrl.split("?")[0];
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("workflow-step-exercises")).toHaveAttribute(
      "aria-current", "step", { timeout: 15_000 },
    );

    const form = await openAddForm(page);
    for (const kind of [InteractionKind.SINGLE_CHOICE, InteractionKind.MULTIPLE_CHOICE, InteractionKind.LISTENING]) {
      await form.getByTestId(`interaction-kind-${kind}`).click({ force: true });
      // Options (and their correct-answer toggles) render...
      await expect(form.getByTestId("mcq-correct-toggle").first()).toBeVisible({ timeout: 10_000 });
      // ...but NONE is marked correct on a fresh exercise.
      await expect(
        form.locator('[data-testid="mcq-correct-toggle"][data-correct="true"]'),
      ).toHaveCount(0);
      // Manual-verification artifacts for the multiple-choice (#10) + listening (#11) states.
      if (kind === InteractionKind.MULTIPLE_CHOICE) await page.screenshot({ path: "test-results/bugA-multiple-no-default.png", fullPage: true });
      if (kind === InteractionKind.LISTENING) await page.screenshot({ path: "test-results/bugA-listening-no-default.png", fullPage: true });
    }
  });
});
