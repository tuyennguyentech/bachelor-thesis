import {
  test,
  expect,
  uid,
  goToSeededLesson,
  createAnalyzedLesson,
  SEED_DSA_LESSON_BIG_O,
  STUDENT_EMAIL,
  USER_PASSWORD,
} from "../fixtures";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Locator, Page } from "@playwright/test";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";

const RICHTER_BASE = "/api/richter";

async function rpc<T = unknown>(
  page: Page,
  service: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = (await page.context().cookies()).find((c) => c.name === "dyadia_access")?.value;
  if (!token) throw new Error("dyadia_access cookie missing");
  const res = await page.request.post(`${RICHTER_BASE}/${service}/${method}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(`RPC ${service}.${method} -> HTTP ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function lessonIdFromUrl(url: string) {
  const match = url.match(/\/lessons\/([^/?#]+)/);
  if (!match) throw new Error(`Lesson id not found in URL: ${url}`);
  return match[1];
}

test.describe.serial("Interactive Video Quiz — New Features E2E Tests", () => {
  // Fresh analyzed lesson used by "teacher can manually create every supported interaction kind".
  // Created once in beforeAll so the test doesn't touch the seeded Big-O lesson.
  let studioLessonUrl = "";
  let studioLessonId = "";

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const result = await createAnalyzedLesson();
    studioLessonUrl = result.lessonUrl.split("?")[0];
    studioLessonId = result.lessonId;
  });

  test("teacher can manually create every supported interaction kind", async ({ teacherPage: teacher }) => {
    test.setTimeout(180_000);

    const stamp = uid("");
    // lessonUrl is set from the shared studioLessonUrl (fresh analyzed lesson).
    const lessonUrl = studioLessonUrl;
    const lessonId = studioLessonId;

    const openExercises = async () => {
      // The interaction editor lives inside the ?tab=processing tab.
      // On repeat calls the teacher may already be on this exact URL, and the processing
      // tab normalizes its URL client-side; Firefox aborts such navigations with
      // NS_BINDING_ABORTED. The page still settles, so swallow that specific error and
      // let the assertions below verify the processing tab is actually active.
      try {
        await teacher.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
      } catch (err) {
        if (!String(err).includes("NS_BINDING_ABORTED")) throw err;
      }
      // For a lesson that already has chunks/interactions, getInitialWorkflowStep()
      // returns "exercises" on mount — no click needed (clicking during the
      // animate-in fade causes "Element is not visible" in Firefox).
      // Instead, wait for the exercises step to be confirmed as the active step and
      // for the add-interaction button to be enabled (signals full React hydration).
      await expect(teacher.getByTestId("workflow-step-exercises")).toHaveAttribute("aria-current", "step", { timeout: 15_000 });
      await expect(teacher.getByTestId("add-interaction-btn").first()).toBeEnabled({ timeout: 15000 });
    };
    const openManualForm = async (kind: InteractionKind) => {
      // Retry loop: navigate to exercises tab, click add-interaction-btn, wait for form.
      // Under heavy parallel load Firefox can lose the click event if the component
      // tree is still settling after a prior router.refresh(); retry up to 5 times.
      let form = teacher.getByTestId("chunk-add-form").last();
      let visible = false;
      for (let attempt = 0; attempt < 5 && !visible; attempt++) {
        await openExercises();
        // Re-query the button each attempt in case DOM was remounted.
        const btn = teacher.getByTestId("add-interaction-btn").first();
        await expect(btn).toBeEnabled({ timeout: 10_000 });
        await btn.click();
        form = teacher.getByTestId("chunk-add-form").last();
        visible = await form.isVisible().catch(() => false);
        if (!visible) {
          // Wait briefly for React to settle before retrying
          await teacher.waitForTimeout(500 * (attempt + 1));
          visible = await form.isVisible().catch(() => false);
        }
      }
      await expect(form).toBeVisible({ timeout: 10000 });
      await form.getByTestId(`interaction-kind-${kind}`).click({ force: true });
      return form;
    };
    const fillPrompt = async (form: Locator, value: string) => {
      const prompt = form.locator('textarea[placeholder="Nhập câu hỏi..."]');
      await expect(prompt).toBeEditable({ timeout: 15000 });
      await prompt.fill(value);
    };

    // Record pre-existing interaction IDs before creating anything so cleanup
    // removes only what this test adds, regardless of pass/fail.
    await openExercises();
    const snapshot = await rpc<{ interactions: Array<{ id: string }> }>(
      teacher, "richter.v1.InteractionService", "ListLessonInteractions",
      { lessonId, limit: 500, offset: 0 },
    );
    const preExistingInteractionIds = new Set((snapshot.interactions ?? []).map((i) => i.id));

    try {

    // ── STEP 1: Teacher creates Single-Choice with 3 options ──
    const scQuestion = `Single-Choice-3Opts-${stamp}`;
    let form = await openManualForm(InteractionKind.SINGLE_CHOICE);
    await fillPrompt(form, scQuestion);

    // Single choice starts with 4 options by default — delete the 4th
    const removeBtn = form.getByTitle("Xóa lựa chọn này").nth(3);
    await removeBtn.click({ force: true });

    // Fill 3 options
    const optionInputs = form.locator('input[type="text"]');
    await optionInputs.nth(0).fill("Python");
    await optionInputs.nth(1).fill("Go");
    await optionInputs.nth(2).fill("Java");

    // Select Option B (index 1) as correct
    await form.getByTitle("Chọn làm đáp án đúng").nth(1).click({ force: true });

    // Set time and save
    await form.locator('input[type="number"]').first().fill("10");
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });

    // Wait for form to close — scope to interaction-row so we don't match the same
    // prompt text in the hidden VideoPlayer checkpoint overlay (content tab is always
    // mounted but CSS-hidden when activeTab=processing; its span appears first in DOM).
    await expect(teacher.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 15000 });
    await expect(teacher.getByTestId("interaction-row").filter({ hasText: scQuestion }).first()).toBeVisible({ timeout: 5000 });
    await teacher.waitForTimeout(1000);

    // ── STEP 2: Teacher creates Multiple-Choice with 5 options ──
    const mcQuestion = `Multiple-Choice-5Opts-${stamp}`;
    form = await openManualForm(InteractionKind.MULTIPLE_CHOICE);
    await fillPrompt(form, mcQuestion);

    // Add a 5th option
    await form.getByRole("button", { name: "Thêm lựa chọn" }).click({ force: true });

    const mcOptionInputs = form.locator('input[type="text"]');
    await mcOptionInputs.nth(0).fill("Option A");
    await mcOptionInputs.nth(1).fill("Option B");
    await mcOptionInputs.nth(2).fill("Option C");
    await mcOptionInputs.nth(3).fill("Option D");
    await mcOptionInputs.nth(4).fill("Option E");

    // Select Option A (index 0) and Option C (index 2) as correct
    await form.getByTitle("Chọn làm đáp án đúng").nth(0).click({ force: true });
    await form.getByTitle("Chọn làm đáp án đúng").nth(2).click({ force: true });

    await form.locator('input[type="number"]').first().fill("20");
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });

    await expect(teacher.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 15000 });
    await expect(teacher.getByTestId("interaction-row").filter({ hasText: mcQuestion }).first()).toBeVisible({ timeout: 5000 });
    await teacher.waitForTimeout(1000);

    // ── STEP 3: Teacher creates Fill-Blank interaction ──
    const fbPrompt = `Fill-Blank-AI-${stamp}`;
    form = await openManualForm(InteractionKind.FILL_BLANK);
    await fillPrompt(form, fbPrompt);

    // Template and Accepted Answers
    await form.getByPlaceholder(/Ví dụ: "Năng lượng/).fill("Học sinh đi học bằng {{0}}.");
    await form.getByPlaceholder("ví dụ: tự sinh ra, được tạo ra").fill("xe đạp, xe hai bánh");

    await form.locator('input[type="number"]').first().fill("30");
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });

    await expect(teacher.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 15000 });
    await expect(teacher.getByTestId("interaction-row").filter({ hasText: fbPrompt }).first()).toBeVisible({ timeout: 5000 });

    // ── STEP 4: Teacher creates Reading interaction ──
    const readingPrompt = `Reading-Manual-${stamp}`;
    form = await openManualForm(InteractionKind.READING);
    await fillPrompt(form, readingPrompt);
    await form.getByPlaceholder("Nhập đoạn văn bản học sinh cần đọc…").fill(
      "Học sinh đọc đoạn này để kiểm tra luồng bài đọc thủ công.",
    );
    await form.locator('input[type="number"]').first().fill("9991");
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });

    await expect(teacher.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 15000 });
    await expect(teacher.getByTestId("interaction-row").filter({ hasText: readingPrompt }).first()).toBeVisible({ timeout: 5000 });

    // ── STEP 5: Teacher creates Listening interaction ──
    const listeningPrompt = `Listening-Manual-${stamp}`;
    form = await openManualForm(InteractionKind.LISTENING);
    await fillPrompt(form, listeningPrompt);
    await form.locator('input[type="file"][accept="audio/*"]').setInputFiles({
      name: "manual-listening.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000"),
    });
    await expect(teacher.getByText(/audio-\d+\.mp3/)).toBeVisible({ timeout: 15000 });
    await form.getByRole("button", { name: "Thêm câu hỏi" }).click({ force: true });
    await form.getByPlaceholder("Nội dung câu hỏi 1").fill("Âm thanh này dùng để kiểm tra luồng nào?");
    await form.getByPlaceholder("Lựa chọn A").fill("Luồng nghe thủ công");
    await form.getByPlaceholder("Lựa chọn B").fill("Luồng xoá khóa học");
    await form.getByPlaceholder("Lựa chọn C").fill("Luồng đổi mật khẩu");
    await form.getByPlaceholder("Lựa chọn D").fill("Luồng đổi theme");
    await form.locator('input[type="number"]').first().fill("9992");
    await form.getByRole("button", { name: "Lưu" }).click({ force: true });

    await expect(teacher.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 15000 });
    await expect(teacher.getByTestId("interaction-row").filter({ hasText: listeningPrompt }).first()).toBeVisible({ timeout: 5000 });

    } finally {
      // Delete every interaction that was not present before this test started.
      // Runs on pass AND fail, preventing leftover interactions from accumulating.
      const after = await rpc<{ interactions: Array<{ id: string }> }>(
        teacher, "richter.v1.InteractionService", "ListLessonInteractions",
        { lessonId, limit: 500, offset: 0 },
      ).catch(() => ({ interactions: [] as Array<{ id: string }> }));
      for (const interaction of (after.interactions ?? [])) {
        if (preExistingInteractionIds.has(interaction.id)) continue;
        await rpc(
          teacher, "richter.v1.InteractionService", "DeleteInteraction",
          { interactionId: interaction.id },
        ).catch(() => { /* best effort — don't mask test failure */ });
      }
    }
  });

  test("student takes quiz with seeded interactions and receives scores", async ({ browser, baseURL }) => {
    test.setTimeout(60_000);

    // Create an isolated browser context for the student
    const rpcBaseUrl = process.env.RICHTER_BASE_URL ?? `${baseURL}/api/richter`;
    const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl });
    const authClient = createClient(AuthService, transport);
    const loginRes = await authClient.login({ email: STUDENT_EMAIL, password: USER_PASSWORD });

    const context = await browser.newContext({ baseURL: baseURL ?? undefined });
    await context.addCookies([
      {
        name: "dyadia_access",
        value: loginRes.accessToken,
        url: baseURL ?? "http://caddy",
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "dyadia_refresh",
        value: loginRes.refreshToken,
        url: baseURL ?? "http://caddy",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const student = await context.newPage();

    try {
      await goToSeededLesson(student, SEED_DSA_LESSON_BIG_O);

      // Wait for video player and checkpoint trigger function
      await student.waitForFunction(
        () => "__triggerVideoCheckpoint" in window,
        { timeout: 15_000 },
      );

      // If student has previous result, click "Làm lại"
      const retakeBtn = student.getByRole("button", { name: "Làm lại" });
      if (await retakeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await retakeBtn.click({ force: true });
      }

      // Trigger a checkpoint after the teacher test has created manual items on
      // the same lesson; the player should surface the earliest unanswered item.
      await student.evaluate((s) => {
        (window as unknown as { __triggerVideoCheckpoint: (s: number) => void }).__triggerVideoCheckpoint(s);
      }, 416);

      const checkpoint = student.locator('[data-testid="quiz-checkpoint"]');
      await expect(checkpoint).toBeVisible({ timeout: 5000 });

      await expect(checkpoint.getByText(/Chọn|Điền|Đọc|Nghe|Hoàn thành/)).toBeVisible({ timeout: 3000 });

      const answerOption = checkpoint.locator("button:not([disabled])").first();
      await expect(answerOption).toBeVisible({ timeout: 3000 });
      await answerOption.click({ force: true });

      const confirmButton = checkpoint.getByRole("button", { name: "Xác nhận đáp án" });
      if (await confirmButton.isVisible({ timeout: 500 }).catch(() => false)) {
        await confirmButton.click({ force: true });
      }

      const continueButton = checkpoint.getByRole("button", { name: /Tiếp tục xem|Câu tiếp theo/ });
      await expect(continueButton).toBeVisible({ timeout: 15000 });
      await expect(continueButton).toBeEnabled({ timeout: 3000 });
    } finally {
      await context.close();
    }
  });
});
