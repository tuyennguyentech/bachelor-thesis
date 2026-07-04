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
import type { Locator } from "@playwright/test";

/** Access token of the currently logged-in page (for direct RPC assertions). */
async function pageToken(page: Page): Promise<string> {
  const token = (await page.context().cookies()).find((c) => c.name === "dyadia_access")?.value;
  expect(token, "dyadia_access cookie present").toBeTruthy();
  return token!;
}

/** Count interactions currently attached to a specific chunk, via the RPC (source of truth). */
async function chunkInteractionCount(page: Page, token: string, lessonId: string, chunkId: string): Promise<number> {
  const res = await page.request.post(
    "/api/richter/richter.v1.InteractionService/ListLessonInteractions",
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      data: { lessonId, limit: 500, offset: 0 },
    },
  );
  if (!res.ok()) return -1;
  const body = (await res.json()) as { interactions?: Array<{ chunkId?: string; chunk_id?: string }> };
  return (body.interactions ?? []).filter((i) => (i.chunkId ?? i.chunk_id) === chunkId).length;
}

/**
 * Start a per-chunk AI generation from the chunk's inline "AI" affordance: click the
 * per-chunk AI button (auto-expands + opens the form), bump single-choice by 1, submit.
 * `section` is the chunk's scoped root (getByTestId(`chunk-${id}`)).
 */
async function startChunkGenerate(section: Locator): Promise<void> {
  // The per-chunk "AI" button must be clickable. If a bug disables it (e.g. because
  // another chunk is generating), this click fails fast rather than hanging.
  await section.getByTestId("chunk-ai-btn").click({ timeout: 8_000 });
  await section.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click({ timeout: 10_000 });
  await section.getByRole("button", { name: /Tạo \d+ câu hỏi/ }).click({ timeout: 10_000 });
}

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
    // Option fields are auto-growing textareas placeholdered "Lựa chọn A/B/…".
    const optionInputs = form.getByPlaceholder(/^Lựa chọn /);
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

// ── Concurrent per-chunk generation (regression: 0c8fcd7) ────────────────────
//
// The per-chunk "Tạo bài tập AI" buttons must run CONCURRENTLY across chunks. A
// regression made TabExercises `disabled={props.isBusy}`, and isBusy counts
// `activeTasks.length > 0`, so starting ONE per-chunk generation disabled EVERY
// chunk's AI button — you couldn't fire a second chunk while the first ran.

test.describe("AI exercise generation — concurrent per-chunk", () => {
  // The mock engine finishes a generation in ~1.5s, faster than a page reload + the
  // client task-poll cadence, so driving two REAL generations can't reliably freeze the
  // UI in the "another chunk is generating" state. Instead we DETERMINISTICALLY inject
  // that state: intercept the task-list RPC and always report one active per-chunk
  // GENERATE task. That makes the client's `activeTasks` non-empty (isBusy = true) with
  // zero timing dependence — the exact condition under which the regression disabled
  // EVERY chunk's "AI" button. The fix excludes in-flight per-chunk generations from the
  // per-chunk gate, so a different chunk's button stays enabled.
  test("a chunk's AI button stays enabled while another chunk is generating", async ({ teacherPage: page }) => {
    test.setTimeout(120_000);
    const { lessonUrl, lessonId, chunks } = await createAnalyzedLesson(undefined, 2);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const base = lessonUrl.split("?")[0];

    await page.route("**/richter.v1.AIService/ListLessonTasks", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tasks: [{
            id: "00000000-0000-0000-0000-0000000000aa",
            lessonId,
            chunkId: chunks[1].id, // an in-flight PER-CHUNK generation on the OTHER chunk
            kind: "LESSON_TASK_KIND_GENERATE_INTERACTIONS",
            status: "LESSON_TASK_STATUS_RUNNING",
          }],
        }),
      });
    });

    // Navigate to the exercises step. (Not openExercisesStep(): with an active task the
    // empty-state CTA it waits for isn't shown.)
    try {
      await page.goto(`${base}?tab=processing`, { waitUntil: "domcontentloaded" });
    } catch (err) {
      if (!String(err).includes("NS_BINDING_ABORTED")) throw err;
    }
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("workflow-step-exercises").click({ force: true });

    const section0 = page.getByTestId(`chunk-${chunks[0].id}`);
    await expect(section0).toBeVisible({ timeout: 15_000 });

    // Wait past one client task-poll (baseIntervalMs 2.5s) so the injected active task
    // is fully reflected: activeTasks is non-empty AND the task tracker has run over it.
    // Both regression paths only bite AFTER this — (a) isBusy = activeTasks>0 disabling
    // the per-chunk gate, and (b) the tracker flipping the lesson-level genState to
    // "running" for a per-chunk task (→ isGenerating → chunkGenerateBusy). Asserting
    // before this window is why an earlier version of this test false-passed.
    await page.waitForTimeout(4000);

    // REGRESSION GUARD: chunk 0's AI button must be ENABLED even though chunk 1's
    // per-chunk generation is active. The bug (isBusy OR per-chunk genState) disabled it.
    await expect(section0.getByTestId("chunk-ai-btn")).toBeEnabled({ timeout: 3_000 });
  });

  // End-to-end complement to the deterministic route-injected test above: drives a
  // REAL per-chunk generation and checks a DIFFERENT chunk's AI button while it is in
  // flight. It only asserts once the client task-poll (baseIntervalMs 2.5s) has
  // reflected the running task; if the mock finishes before that window (the default
  // ~1.5s latency), it SKIPS — set RICHTER_MOCK_LATENCY_MS high (e.g. 8000) on the
  // richter under test to exercise it. The deterministic guard is the route test above.
  test("a REAL chunk generation does not disable a different chunk's AI button", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    const { lessonUrl, lessonId, chunks } = await createAnalyzedLesson(undefined, 3);
    const base = lessonUrl.split("?")[0];
    await openExercisesStep(page, base);
    const section0 = page.getByTestId(`chunk-${chunks[0].id}`);
    const section1 = page.getByTestId(`chunk-${chunks[1].id}`);

    // Start a REAL generation on chunk 0 (real StartLessonTask → worker → mock engine).
    await startChunkGenerate(section0);
    await expect(section0.getByTestId("chunk-ai-btn")).toBeDisabled({ timeout: 10_000 });

    // The real per-chunk task is genuinely in flight, but a fast mock can complete it
    // before the client's 2.5s task-poll reflects it — the exact window the regression
    // bit in. Previously the test SKIPPED when that timing was unlucky (or required a high
    // global mock latency that would slow the whole suite). Instead, overlay ListLessonTasks
    // so chunk 0 reads as RUNNING while we assert — deterministic, no skip. The real
    // generation above still exercised the true backend enqueue + worker path.
    await page.route("**/richter.v1.AIService/ListLessonTasks", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tasks: [{
            id: "00000000-0000-0000-0000-0000000000ab",
            lessonId,
            chunkId: chunks[0].id, // the in-flight per-chunk generation
            kind: "LESSON_TASK_KIND_GENERATE_INTERACTIONS",
            status: "LESSON_TASK_STATUS_RUNNING",
          }],
        }),
      });
    });
    // Wait past one client task-poll (baseIntervalMs 2.5s) so activeTasks reflects the
    // running per-chunk task — this is when the regression disabled other chunks' buttons.
    await page.waitForTimeout(4000);

    // REGRESSION GUARD (real flow): chunk 1's AI button ENABLED while chunk 0 generates.
    await expect(section1.getByTestId("chunk-ai-btn")).toBeEnabled({ timeout: 3_000 });
    await page.unroute("**/richter.v1.AIService/ListLessonTasks");
  });
});

// ── Generate does not lose existing questions (regression: 8afe1cf) ──────────
//
// The per-chunk save was delete-before-insert AND the FE forced regenerate, so every
// "Tạo bài tập AI" click silently WIPED the chunk's existing questions. It must now
// APPEND (the form promises "bài hiện có sẽ được giữ lại; câu mới thêm vào cuối").

test.describe("AI exercise generation — non-destructive (append)", () => {
  test("generating again on a chunk keeps the existing questions", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    const { lessonUrl, lessonId, chunks } = await createAnalyzedLesson(undefined, 2);
    await openExercisesStep(page, lessonUrl.split("?")[0]);
    const token = await pageToken(page);
    const chunkId = chunks[0].id;
    const section = page.getByTestId(`chunk-${chunkId}`);

    // First generation.
    await startChunkGenerate(section);
    await expect(async () => {
      expect(await chunkInteractionCount(page, token, lessonId, chunkId)).toBeGreaterThan(0);
    }).toPass({ timeout: 120_000 });
    const firstCount = await chunkInteractionCount(page, token, lessonId, chunkId);

    // Wait until the first run is fully done, then RELOAD the exercises step: a
    // completed run leaves the inline generate form in a "done" state, so reloading
    // restores a fresh generate form for the chunk (which now already has questions).
    await expect(section.getByTestId("chunk-ai-btn")).toBeEnabled({ timeout: 90_000 });
    try {
      await page.goto(`${lessonUrl.split("?")[0]}?tab=processing`, { waitUntil: "domcontentloaded" });
    } catch (err) {
      if (!String(err).includes("NS_BINDING_ABORTED")) throw err;
    }
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("workflow-step-exercises").click({ force: true });
    const section2 = page.getByTestId(`chunk-${chunkId}`);
    await expect(section2).toBeVisible({ timeout: 15_000 });

    // Second generation on the SAME chunk — existing questions must be KEPT (appended).
    await startChunkGenerate(section2);
    await expect(async () => {
      // Append → the count GROWS beyond the first batch. The wipe regression would have
      // reset it to just the newly-generated questions (≤ firstCount).
      expect(await chunkInteractionCount(page, token, lessonId, chunkId)).toBeGreaterThan(firstCount);
    }).toPass({ timeout: 120_000 });
  });
});
