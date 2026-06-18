/**
 * E2E regression tests for the lesson "Tạo bài tập" (exercise) workflow.
 *
 * Covers three reported bugs:
 *  - #4 AI generation config must default to 0 for EVERY question kind (it used
 *       to silently pre-fill 1 single-choice).
 *  - #3 Manual creation ("Thêm") must stay available WHILE an AI generation is
 *       running — the two run in parallel (independent backend paths).
 *  - #2 After a long-running task finishes, the page-level lesson tabs
 *       ("Bài giảng" / "Kết quả & Thống kê") must remain clickable (a stuck
 *       router.refresh used to wedge tab navigation).
 *
 * Each test provisions its OWN freshly analyzed lesson (unique teacher/course),
 * so they are isolated and parallel-safe and never pollute the shared seed.
 * The richter test config uses the in-process MOCK Gemini engine, so AI
 * generation runs deterministically without the real API.
 */

import { test, expect, createAnalyzedLesson, InteractionKind, type Page } from "../fixtures";

const KIND_LABELS = [
  "Trắc nghiệm 1 đáp án",
  "Trắc nghiệm nhiều đáp án",
  "Điền đáp án",
  "Bài đọc",
  "Bài nghe",
];

/**
 * Navigate `teacher` to the processing tab and select the "Bài tập" (exercises)
 * workflow step. Returns the lesson URL (query stripped). The processing tab
 * normalises its URL client-side; Firefox aborts that with NS_BINDING_ABORTED —
 * swallow it and assert the step is active instead.
 */
async function openExercisesStep(page: Page, lessonUrl: string): Promise<void> {
  try {
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
  } catch (err) {
    if (!String(err).includes("NS_BINDING_ABORTED")) throw err;
  }
  await expect(page.getByTestId("video-workflow-stepper")).toBeVisible({ timeout: 20_000 });
  const exStep = page.getByTestId("workflow-step-exercises");
  await expect(exStep).toBeVisible({ timeout: 15_000 });
  // The step may already be active on mount; click only re-selects it.
  await exStep.click({ force: true });
  await expect(exStep).toHaveAttribute("aria-current", "step", { timeout: 15_000 });
  // Empty lesson → EmptyExerciseState CTA; ensure the generate trigger is mounted.
  await expect(page.getByTestId("generate-all-btn").first()).toBeVisible({ timeout: 15_000 });
}

// ── Bug #4: AI generation config defaults to 0 for every kind ────────────────

test.describe("AI exercise generation — default config", () => {
  test("dialog opens with every kind at 0 (no pre-filled MCQ)", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    const { lessonUrl } = await createAnalyzedLesson(undefined, 2);
    await openExercisesStep(page, lessonUrl.split("?")[0]);

    await page.getByTestId("generate-all-btn").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Tạo bài tập bằng AI" })).toBeVisible({ timeout: 10_000 });

    // The lesson has no saved default config → every kind counter must read 0.
    for (const label of KIND_LABELS) {
      await expect(dialog.getByLabel(`Số câu ${label}`, { exact: true })).toHaveValue("0");
    }
    // Total 0 → "Dự kiến tạo" 0 and the generate button is disabled until > 0.
    await expect(dialog.getByText("0 câu / phân đoạn").first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Tạo .* bài tập/ })).toBeDisabled();
  });
});

// ── Bug #3: manual "Thêm" stays usable while an AI generation runs ───────────

test.describe("AI exercise generation — parallel manual add", () => {
  test("manual 'Thêm' is usable while a lesson-level AI generation runs", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    // 5 chunks → the generation runs long enough to stay in flight while we fill and
    // save the manual form (so the two genuinely overlap, and the gen-completion
    // re-render does not race the form fill).
    const { lessonUrl, lessonId } = await createAnalyzedLesson(undefined, 5);
    await openExercisesStep(page, lessonUrl.split("?")[0]);

    // Start a lesson-level AI generation: open dialog, bump single-choice to 1, run.
    await page.getByTestId("generate-all-btn").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();
    await dialog.getByRole("button", { name: /Tạo \d+ bài tập/ }).click();

    // Generation is now in flight — the progress hero confirms the running state.
    await expect(page.getByTestId("generation-progress")).toBeVisible({ timeout: 20_000 });

    // REGRESSION: the manual "Thêm" affordance must NOT be disabled by the
    // running generation. Before the fix `isAddingDisabled` included isGenerating,
    // so this button was disabled and the form below was unreachable.
    const addBtn = page.getByTestId("add-interaction-btn").first();
    await expect(addBtn).toBeEnabled({ timeout: 10_000 });
    await addBtn.click();

    // The manual add form opens and is fully usable even while AI generation runs.
    const form = page.getByTestId("chunk-add-form").first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByTestId(`interaction-kind-${InteractionKind.SINGLE_CHOICE}`).click({ force: true });

    const manualPrompt = "Câu hỏi thủ công tạo song song với AI";
    const prompt = form.locator('textarea[placeholder="Nhập câu hỏi..."]');
    await expect(prompt).toBeEditable({ timeout: 10_000 });
    await prompt.fill(manualPrompt);

    // Fill the single-choice options and pick a correct answer so the form validates.
    const optionInputs = form.locator('input[type="text"]');
    const optionCount = await optionInputs.count();
    for (let i = 0; i < optionCount; i++) {
      await optionInputs.nth(i).fill(`Lựa chọn ${i + 1}`);
    }
    await form.getByTitle("Chọn làm đáp án đúng").first().click({ force: true });
    await form.locator('input[type="number"]').first().fill("3");

    // Save the manual interaction WHILE the AI generation is still in flight. The
    // form closes ONLY on a successful CreateManualInteraction, so its disappearance
    // proves the manual create RPC succeeded concurrently with the AI generation.
    await expect(form.getByRole("button", { name: "Lưu" })).toBeEnabled({ timeout: 10_000 });
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });
    await expect(page.getByTestId("chunk-add-form")).toHaveCount(0, { timeout: 15_000 });

    // Confirm persistence at the source of truth: the manually-created interaction
    // exists in the backend. (We assert against the DB rather than the live list,
    // which the AI generation's completion may transiently re-render.)
    const token = (await page.context().cookies()).find((c) => c.name === "dyadia_access")?.value;
    expect(token, "dyadia_access cookie present").toBeTruthy();
    await expect(async () => {
      const res = await page.request.post(
        "/api/richter/richter.v1.InteractionService/ListLessonInteractions",
        {
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          data: { lessonId, limit: 500, offset: 0 },
        },
      );
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { interactions?: Array<{ prompt?: string }> };
      const prompts = (body.interactions ?? []).map((i) => i.prompt ?? "");
      expect(prompts).toContain(manualPrompt);
    }).toPass({ timeout: 20_000 });
  });
});

// ── Bug #2: lesson tabs stay clickable after a task finishes ────────────────

test.describe("Lesson tabs — clickable after a task completes", () => {
  test("after an AI generation finishes, Bài giảng / Kết quả tabs still navigate", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    const { lessonUrl } = await createAnalyzedLesson(undefined, 2);
    const base = lessonUrl.split("?")[0];
    await openExercisesStep(page, base);

    // Run a quick lesson-level generation so a task transitions to terminal while
    // we sit on the processing tab (the scenario that used to wedge navigation).
    await page.getByTestId("generate-all-btn").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();
    await dialog.getByRole("button", { name: /Tạo \d+ bài tập/ }).click();
    // Wait for the generation to reach a terminal state (success banner).
    await expect(page.getByTestId("gen-done")).toBeVisible({ timeout: 60_000 });

    // Now the page-level tabs must remain responsive. Clicking "Kết quả & Thống kê"
    // and "Bài giảng" must actually navigate (no stuck router.refresh wedging them).
    await page.getByRole("tab", { name: /Kết quả.*Thống kê/ }).click();
    await expect(page).toHaveURL(/tab=results/, { timeout: 15_000 });

    await page.getByRole("tab", { name: /Bài giảng/ }).click();
    await expect(page).toHaveURL(/tab=content/, { timeout: 15_000 });
    await expect(page.getByText("Studio bài giảng")).toBeVisible({ timeout: 15_000 });
  });
});
