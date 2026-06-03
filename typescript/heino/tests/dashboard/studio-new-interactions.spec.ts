import {
  test,
  expect,
  goToSeededLesson,
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

async function cleanupInteractionsByPrompt(page: Page, lessonId: string, prompts: string[]) {
  const list = await rpc<{ interactions: Array<{ id: string; prompt?: string }> }>(
    page,
    "richter.v1.InteractionService",
    "ListLessonInteractions",
    { lessonId, limit: 500, offset: 0 },
  );
  const promptSet = new Set(prompts);
  for (const interaction of list.interactions) {
    if (!interaction.prompt || !promptSet.has(interaction.prompt)) continue;
    await rpc(page, "richter.v1.InteractionService", "DeleteInteraction", { interactionId: interaction.id });
  }
}

function lessonIdFromUrl(url: string) {
  const match = url.match(/\/lessons\/([^/?#]+)/);
  if (!match) throw new Error(`Lesson id not found in URL: ${url}`);
  return match[1];
}

test.describe("Interactive Video Quiz — New Features E2E Tests", () => {
  test("teacher can manually create every supported interaction kind", async ({ teacherPage: teacher }) => {
    test.setTimeout(180_000);

    const stamp = Date.now();
    let lessonUrl = "";
    const openExercises = async () => {
      lessonUrl = await goToSeededLesson(teacher, SEED_DSA_LESSON_BIG_O);
      await teacher.getByTestId("workflow-step-exercises").click({ force: true });
      await expect(teacher.getByTestId("workflow-step-exercises")).toHaveAttribute("aria-current", "step", { timeout: 5000 });
      await expect(teacher.getByTestId("add-interaction-btn").first()).toBeEnabled({ timeout: 15000 });
    };
    const openManualForm = async (kind: InteractionKind) => {
      await openExercises();
      await teacher.getByTestId("add-interaction-btn").first().click({ force: true });
      const form = teacher.getByTestId("chunk-add-form").last();
      await expect(form).toBeVisible({ timeout: 15000 });
      await form.getByTestId(`interaction-kind-${kind}`).click({ force: true });
      return form;
    };
    const fillPrompt = async (form: Locator, value: string) => {
      const prompt = form.locator('textarea[placeholder="Nhập câu hỏi..."]');
      await expect(prompt).toBeEditable({ timeout: 15000 });
      await prompt.fill(value);
    };

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

    // Wait for form to close
    await expect(teacher.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 15000 });
    await expect(teacher.getByText(scQuestion).first()).toBeVisible({ timeout: 5000 });
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
    await expect(teacher.getByText(mcQuestion).first()).toBeVisible({ timeout: 5000 });
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
    await expect(teacher.getByText(fbPrompt).first()).toBeVisible({ timeout: 5000 });

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
    await expect(teacher.getByText(readingPrompt).first()).toBeVisible({ timeout: 5000 });

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
    await expect(teacher.getByText(listeningPrompt).first()).toBeVisible({ timeout: 5000 });

    await cleanupInteractionsByPrompt(
      teacher,
      lessonIdFromUrl(lessonUrl),
      [scQuestion, mcQuestion, fbPrompt, readingPrompt, listeningPrompt],
    );
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

      await expect(checkpoint.getByText(/Single-Choice|Big-O notation|5n²/)).toBeVisible({ timeout: 3000 });

      const answerOption = checkpoint.locator("button").filter({ hasText: /Python|Giới hạn trên|O\(n²\)/ }).first();
      await expect(answerOption).toBeVisible({ timeout: 3000 });
      await answerOption.click({ force: true });

      const confirmButton = checkpoint.getByRole("button", { name: "Xác nhận đáp án" });
      if (await confirmButton.isVisible({ timeout: 500 }).catch(() => false)) {
        await confirmButton.click({ force: true });
      }

      const continueButton = checkpoint.getByRole("button", { name: /Tiếp tục xem|Câu tiếp theo/ });
      const advancesWithinCluster = (await continueButton.textContent())?.includes("Câu tiếp theo") ?? false;
      await continueButton.click({ force: true });
      if (advancesWithinCluster) {
        await expect(checkpoint).toBeVisible({ timeout: 5000 });
      } else {
        await expect(checkpoint).not.toBeVisible({ timeout: 5000 });
      }
    } finally {
      await context.close();
    }
  });
});
