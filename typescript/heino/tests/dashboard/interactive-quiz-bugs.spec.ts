/**
 * E2E tests for three critical video quiz bugs:
 *
 *   1. Quiz overlay uses spacious max-w-4xl card layout (not cramped max-w-lg).
 *   2. Retake resets video playhead to 0 and pauses.
 *   3. "Làm lại" button is disabled when attemptCount >= maxAttempts.
 *
 * Isolation: each worker creates its own course+module+lesson via
 * createAnalyzedLesson(), seeds MCQ interactions, and creates a fresh student
 * who submits one attempt — so no test mutates the shared Big-O seed lesson.
 */

import type { Page } from "@playwright/test";
import {
  test as base,
  expect,
  createAnalyzedLesson,
  createUser,
  addCourseMember,
  addOrgMember,
  getOrgId,
  getAdminAuth,
  getToken,
  loginAs,
  authedClient,
  uid,
  rpcBaseUrl,
  CourseRole,
  OrganizationRole,
  SEED_HUST_CS_SLUG,
  USER_PASSWORD,
} from "../fixtures";
import { InteractionService } from "buf/gen/richter/v1/interactions_pb";

// Checkpoint seconds for the fresh lesson interactions (within edu-sample-en.mp4 ~6.3 s).
// We create 5 MCQ interactions at these start_seconds so the answerCheckpoints loop works.
const CHECKPOINT_SECONDS = [1, 2, 3, 4, 5];
const RICHTER_BASE = "/api/richter";

/** Wait for React hydration to register the checkpoint test hook, then fire it. */
async function triggerCheckpoint(page: Page, seconds: number) {
  await page.waitForFunction(() => "__triggerVideoCheckpoint" in window, { timeout: 5_000 });
  await page.evaluate((s) => {
    (window as unknown as { __triggerVideoCheckpoint: (s: number) => void }).__triggerVideoCheckpoint(s);
  }, seconds);
}

/**
 * Set maxAttempts on a lesson.
 * Accepts either a Page (reads dyadia_access cookie) or a token string directly.
 * Using a token string avoids shared-context cookie pollution when multiple fixtures
 * (freshStudentPage + teacherPage) are used in the same test.
 */
async function setMaxAttempts(
  pageOrToken: Page | string,
  lessonId: string,
  maxAttempts: number,
) {
  const token = typeof pageOrToken === "string"
    ? pageOrToken
    : await getTeacherTokenFromPage(pageOrToken);

  if (typeof pageOrToken === "string") {
    // API-only path — Node fetch with richter directly (no browser page needed)
    const richterBase = process.env.RICHTER_BASE_URL ?? "http://caddy/api/richter";
    const getRes = await fetch(`${richterBase}/richter.v1.LessonService/GetLessonById`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: lessonId }),
    });
    if (!getRes.ok) throw new Error(`GetLessonById failed: ${getRes.status} ${await getRes.text()}`);
    const body = await getRes.json() as { lesson: { title: string; orderIndex: number } };
    const updRes = await fetch(`${richterBase}/richter.v1.LessonService/UpdateLesson`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: lessonId, title: body.lesson.title, orderIndex: body.lesson.orderIndex, maxAttempts }),
    });
    if (!updRes.ok) throw new Error(`UpdateLesson failed: ${updRes.status} ${await updRes.text()}`);
  } else {
    // Browser page path — use page.request for consistency with Caddy routing
    const res = await pageOrToken.request.post(`${RICHTER_BASE}/richter.v1.LessonService/GetLessonById`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      data: { id: lessonId },
    });
    const body = await res.json() as { lesson: { title: string; orderIndex: number } };
    await pageOrToken.request.post(`${RICHTER_BASE}/richter.v1.LessonService/UpdateLesson`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      data: { id: lessonId, title: body.lesson.title, orderIndex: body.lesson.orderIndex, maxAttempts },
    });
  }
}

/** Extract the teacher's access token from the page's dyadia_access cookie. */
async function getTeacherTokenFromPage(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const c = cookies.find((c) => c.name === "dyadia_access");
  if (!c) throw new Error("dyadia_access cookie missing");
  return c.value;
}

/**
 * Create a single-choice MCQ interaction via node fetch (no Page needed).
 * Uses the richter Connect RPC endpoint directly.
 */
async function createMcqInteraction(
  token: string,
  lessonId: string,
  prompt: string,
  startSeconds: number,
  baseURL?: string,
): Promise<string> {
  const rpcUrl = `${rpcBaseUrl(baseURL)}/richter.v1.InteractionService/CreateManualInteraction`;
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      lessonId,
      prompt,
      explanation: "",
      startSeconds,
      chunkId: "",
      mcq: {
        options: [{ text: "Đáp án A" }, { text: "Đáp án B" }],
        correctAnswer: 0,
        correctAnswers: [],
        question: "",
      },
    }),
  });
  if (!res.ok) throw new Error(`createMcqInteraction failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { interaction: { id: string } };
  return body.interaction.id;
}

// ── Shared state (set in beforeAll, read by tests) ───────────────────────────

interface IsolatedFixture {
  lessonId: string;
  courseId: string;
  lessonUrl: string;
  teacherToken: string;
  freshStudentEmail: string;
}

const sharedState: IsolatedFixture = {
  lessonId: "",
  courseId: "",
  lessonUrl: "",
  teacherToken: "",
  freshStudentEmail: "",
};

// ── Extended test with freshStudentPage fixture ──────────────────────────────

const test = base.extend<{ freshStudentPage: Page }>({
  freshStudentPage: async ({ page, baseURL }, use) => {
    // sharedState.freshStudentEmail is set in beforeAll
    await loginAs(page, sharedState.freshStudentEmail, USER_PASSWORD, baseURL ?? "http://caddy");
    await use(page);
  },
});

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe.serial("Interactive Video Quiz Overlay & Retake Constraints", () => {
  test.beforeAll(async () => {
    // 1. Create isolated course + module + lesson with a real video + chunks.
    //    Uses a fresh unique teacher so the 3-task cap is never shared.
    const { lessonId, courseId, lessonUrl, token } = await createAnalyzedLesson();

    // 2. Seed 5 MCQ interactions at CHECKPOINT_SECONDS so all tests have checkpoints to fire.
    for (let i = 0; i < CHECKPOINT_SECONDS.length; i++) {
      await createMcqInteraction(
        token,
        lessonId,
        `Câu hỏi kiểm tra số ${i + 1}?`,
        CHECKPOINT_SECONDS[i],
      );
    }

    // 3. Create a fresh student, add them to the hust-cs org, then to the course.
    //    listLessonInteractions requires org membership (not just course membership).
    const { token: adminToken } = await getAdminAuth();
    const freshStudentEmail = `student-${uid("")}@test.local`;
    const freshStudentId = await createUser(
      adminToken,
      { email: freshStudentEmail },
    );
    const orgId = await getOrgId(adminToken, SEED_HUST_CS_SLUG);
    await addOrgMember(adminToken, orgId, freshStudentId, OrganizationRole.STUDENT);
    await addCourseMember(token, courseId, freshStudentId, CourseRole.STUDENT);

    // 4. Submit one attempt as the fresh student so they start in the result state.
    const studentToken = await getToken(freshStudentEmail, USER_PASSWORD);
    const interactionsClient = authedClient(InteractionService, studentToken);
    const interactionsRes = await interactionsClient.listLessonInteractions({
      lessonId,
      limit: 20,
      offset: 0,
    });
    await interactionsClient.submitAttempt({
      lessonId,
      videoWatchFraction: 1.0,
      responses: interactionsRes.interactions.map((it) => ({
        interactionId: it.id,
        timeToAnswerMs: 1000,
        replayCount: 0,
        response: { case: "mcqSelected", value: 0 },
      })),
    });

    // 5. Persist shared state.
    sharedState.lessonId = lessonId;
    sharedState.courseId = courseId;
    sharedState.lessonUrl = lessonUrl;
    sharedState.teacherToken = token;
    sharedState.freshStudentEmail = freshStudentEmail;
  });

  test("quiz overlay uses spacious full-cover video layout", async ({ teacherPage }) => {
    // Teacher views in preview mode → append ?preview=1
    await teacherPage.goto(`${sharedState.lessonUrl}?preview=1`);

    // Wait for the video player to be attached
    await expect(teacherPage.locator('[data-testid="video-player"]')).toBeAttached({ timeout: 10_000 });

    // Trigger a checkpoint to display quiz overlay
    await triggerCheckpoint(teacherPage, CHECKPOINT_SECONDS[0] + 2);

    // Wait for checkpoint to appear
    const checkpoint = teacherPage.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 5_000 });

    // Verify the overlay container has the spacious full-cover layout class
    const card = teacherPage.locator(".w-full.h-full").filter({ has: checkpoint });
    await expect(card).toBeVisible();

    // Verify the overlay background is present (backdrop blur)
    const overlay = teacherPage.locator(".backdrop-blur-md").filter({ has: checkpoint });
    await expect(overlay).toBeVisible();
  });

  test("retake resets video playhead to 0", async ({ freshStudentPage: page }) => {
    // Fresh student has a seeded attempt → starts in result state
    await page.goto(`${sharedState.lessonUrl}`);
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });

    // Set video currentTime to 30 before clicking retake
    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) video.currentTime = 30;
    });

    // Click retake
    await page.getByRole("button", { name: "Làm lại", exact: true }).click();

    // Verify playhead was reset to 0
    const playheadTime = await page.evaluate(() => {
      const video = document.querySelector("video");
      return video ? video.currentTime : -1;
    });
    expect(playheadTime).toBe(0);
  });

  test("retake button disabled when attempt limit reached", async ({
    freshStudentPage: page,
  }) => {
    const { lessonId, lessonUrl, teacherToken } = sharedState;

    // Navigate student to lesson — they have a seeded attempt → should see result
    await page.goto(lessonUrl);
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });

    // Use teacher token directly (avoid teacherPage fixture which shares browser context
    // with freshStudentPage and would overwrite the student's cookies with teacher's cookies).
    // Teacher sets maxAttempts = 1. Fresh student already has 1 attempt, should be blocked.
    await setMaxAttempts(teacherToken, lessonId, 1);

    // Reload to pick up new maxAttempts config
    await page.reload();
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });

    // The retake button should be hidden entirely when max attempts reached
    const retakeBtnAfterLimit = page.getByRole("button", { name: /Làm lại|Hết lượt/ });
    await expect(retakeBtnAfterLimit).not.toBeVisible();

    // Teacher raises maxAttempts to 100 so student can retake
    await setMaxAttempts(teacherToken, lessonId, 100);

    // Reload student's page
    await page.reload();
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });

    // Now the retake button should be active
    const activeBtn = page.getByRole("button", { name: "Làm lại", exact: true });
    await expect(activeBtn).toBeVisible();
    await expect(activeBtn).toBeEnabled();

    // Clean up: reset maxAttempts to 0 (unlimited)
    await setMaxAttempts(teacherToken, lessonId, 0);
  });

  test("preview mode enforces attempt limit correctly", async ({
    teacherPage: page,
  }) => {
    // This test answers 5 checkpoints × 2 attempts + submit flows — needs extra time.
    test.slow();
    const { lessonId, lessonUrl } = sharedState;

    // Set maxAttempts = 2
    await setMaxAttempts(page, lessonId, 2);

    // Open preview mode
    await page.goto(`${lessonUrl}?preview=1`);
    await expect(page.locator('[data-testid="video-player"]')).toBeVisible({ timeout: 10_000 });

    // Local helper to answer all checkpoints.
    // Triggers each checkpoint at startSeconds + 0.05 after explicitly positioning
    // the video just before the target so prevTimeRef is < startSeconds at trigger time.
    // Using s + 2 previously caused checkpoints to be skipped because prevTimeRef
    // accumulated past later checkpoints (e.g. prev=3 means s=2 is never matched).
    const answerCheckpoints = async () => {
      for (const s of CHECKPOINT_SECONDS) {
        // Place video just before the checkpoint so handleFirstPlay() sets
        // prevTimeRef to a value strictly less than startSeconds.
        await page.evaluate((seconds) => {
          const video = document.querySelector("video");
          if (video) video.currentTime = Math.max(0, seconds - 0.1);
        }, s);
        await triggerCheckpoint(page, s + 0.05);
        const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
        await expect(checkpoint).toBeVisible({ timeout: 5_000 });
        await checkpoint.locator("button").first().click();
        await page.getByRole("button", { name: "Tiếp tục xem" }).click();
        await expect(checkpoint).not.toBeVisible({ timeout: 5_000 });
      }
    };

    // ── Attempt 1 ──
    await answerCheckpoints();

    // Submit Attempt 1
    const submitBtn1 = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn1).toBeEnabled();
    await submitBtn1.click();

    // Verify results show up and "Làm lại" button is enabled (since limit is 2)
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });
    const retakeBtn = page.getByRole("button", { name: "Làm lại", exact: true });
    await expect(retakeBtn).toBeVisible();
    await expect(retakeBtn).toBeEnabled();

    // Click "Làm lại" to start Attempt 2
    await retakeBtn.click();
    await expect(page.getByText("🎯 Kết quả")).not.toBeVisible({ timeout: 5_000 });

    // ── Attempt 2 ──
    await answerCheckpoints();

    // Submit Attempt 2
    const submitBtn2 = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn2).toBeEnabled();
    await submitBtn2.click();

    // Verify result is shown, but the retake button is now hidden (max attempts reached)
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });
    const retakeBtnAfterLimit = page.getByRole("button", { name: /Làm lại|Hết lượt/ });
    await expect(retakeBtnAfterLimit).not.toBeVisible();

    // Clean up: reset maxAttempts to 0
    await setMaxAttempts(page, lessonId, 0);
  });
});
