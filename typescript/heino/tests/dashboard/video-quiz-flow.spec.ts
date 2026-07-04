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
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import {
  CourseService,
  CourseModuleService,
  LessonService,
} from "buf/gen/richter/v1/courses_pb";
import {
  OrganizationService,
} from "buf/gen/richter/v1/organizations_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import {
  test,
  expect,
  goToSeededLesson,
  createAnalyzedLesson,
  createInteraction,
  SEED_HUST_CS_SLUG as ORG_SLUG,
  SEED_DSA_LESSON_BIG_O as SEEDED_LESSON,
  TEACHER_EMAIL,
  USER_PASSWORD,
  InteractionKind,
  uid,
} from "../fixtures";

const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");
const TEST_VIDEO_WITH_AUDIO = path.join(__dirname, "../fixtures/edu-sample-en.mp4");

function rpcBaseUrl(baseURL?: string) {
  return process.env.RICHTER_BASE_URL ?? `${baseURL ?? "http://caddy"}/api/richter`;
}

/** Fetch the ACTUAL checkpoint start-seconds (sorted, timed only) for a seeded lesson
 *  via the API. Tests must not hardcode these: the seed fits the golden-fixture
 *  timeline to the real (shorter) demo-video duration, so the timestamps are scaled
 *  and would otherwise drift out from under any magic numbers. `lessonHref` is the
 *  lesson page URL (its last path segment is the lesson id). */
async function fetchCheckpointSeconds(lessonHref: string, baseURL?: string): Promise<number[]> {
  const lessonId = lessonHref.split("?")[0].replace(/\/$/, "").split("/").pop() ?? "";
  const rpcBase = rpcBaseUrl(baseURL);
  const authRes = await createClient(
    AuthService,
    createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBase }),
  ).login({ email: TEACHER_EMAIL, password: USER_PASSWORD });
  const token = authRes.accessToken;
  const authInterceptor: Interceptor = (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
  const aiClient = createClient(
    AIService,
    createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBase, interceptors: [authInterceptor] }),
  );
  const res = await aiClient.getLessonAnalysis({ lessonId });
  return (res.analysis?.interactions ?? [])
    .map((i) => i.startSeconds)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
}

async function ensureRetakeState(page: Page) {
  const retakeBtn = page.getByRole("button", { name: "Làm lại" });
  if (await retakeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await retakeBtn.click();
  }
}

/** Creates a fresh course → module → lesson via the richter API. Returns the lesson URL. */
async function createLesson(
  _page: Page,
  courseTitle: string,
  moduleName: string,
  lessonTitle: string,
  baseURL?: string,
): Promise<string> {
  const rpcBase = rpcBaseUrl(baseURL);
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBase });
  const authRes = await createClient(AuthService, transport).login({
    email: TEACHER_EMAIL,
    password: USER_PASSWORD,
  });
  const token = authRes.accessToken;
  const userId = authRes.user?.id ?? "";

  const authInterceptor: Interceptor = (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
  const authedTransport = createConnectTransport({
    httpVersion: "1.1",
    baseUrl: rpcBase,
    interceptors: [authInterceptor],
  });

  const orgClient = createClient(OrganizationService, authedTransport);
  const orgRes = await orgClient.getOrganizationBySlug({ slug: ORG_SLUG });
  const orgId = orgRes.organization?.id;
  if (!orgId) throw new Error("createLesson: could not resolve org id");

  const courseClient = createClient(CourseService, authedTransport);
  const courseRes = await courseClient.createCourse({
    organizationId: orgId,
    ownerId: userId,
    title: courseTitle,
  });
  const courseId = courseRes.course?.id;
  if (!courseId) throw new Error("createLesson: createCourse returned no id");

  const moduleClient = createClient(CourseModuleService, authedTransport);
  const moduleRes = await moduleClient.createCourseModule({
    courseId,
    title: moduleName,
    orderIndex: 0,
  });
  const moduleId = moduleRes.module?.id;
  if (!moduleId) throw new Error("createLesson: createCourseModule returned no id");

  const lessonClient = createClient(LessonService, authedTransport);
  const lessonRes = await lessonClient.createLesson({
    moduleId,
    title: lessonTitle,
    description: "",
    orderIndex: 0,
  });
  const lessonId = lessonRes.lesson?.id;
  if (!lessonId) throw new Error("createLesson: createLesson returned no id");

  return `/dashboard/organizations/${ORG_SLUG}/courses/${courseId}/lessons/${lessonId}`;
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
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();

    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    await expect(page.getByText(/Đang tải lên/)).toBeVisible();
    // After upload, the component remounts with videoStorageKey set and the workflow advances to
    // the transcript step. "Trích xuất phiên âm" is the stable post-upload indicator.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });
    // Navigate back to the upload step (step 1) to verify the button label changed to "Thay video".
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" }).first()).toBeVisible();
  });

  test("after upload, video key enables AI analysis button", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học AI Enabled"), uid("Chương AI"), uid("Bài AI"),
    );
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    // After upload, authoring workflow appears with the transcript extract button.
    await expect(page.getByText("Tạo nội dung từ video")).toBeVisible();
  });

  test("workflow stepper guides the next video processing action", async ({ teacherPage: page }) => {
    const scriptTagConsoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().includes("Encountered a script tag")) {
        scriptTagConsoleErrors.push(msg.text());
      }
    });

    const url = await createLesson(
      page, uid("Khóa học Workflow"), uid("Chương Workflow"), uid("Bài Workflow"),
    );
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    // Reload to ?tab=processing so the server re-renders with video_key set
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible();
    await expect(page.getByTestId("workflow-next-action")).toContainText("Tiếp theo: Trích xuất phiên âm");
    await expect(page.getByTestId("workflow-step-transcript")).toBeVisible();
    await expect(page.getByTestId("workflow-step-chunks")).toBeDisabled();
    await expect(page.getByText("Video sẵn sàng phiên âm")).toBeVisible();
    await expect(page.getByText("Tác vụ phiên âm")).not.toBeVisible();
    expect(scriptTagConsoleErrors).toEqual([]);
  });

  test("student does not see upload controls", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("Nguồn video")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Thay video" })).not.toBeVisible();
  });
});

// ── 2. Video player visible ────────────────────────────────────────────────

test.describe("Video player", () => {
  test("seeded lesson shows video element", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Requires seed videos uploaded to storage (run: richter seed --dev)
    await expect(page.locator("video").first()).toBeVisible();
  });

  test("lesson without video shows placeholder for student", async ({ studentPage: page }) => {
    // Lesson 3 has no video in seed data
    await goToSeededLesson(page, "Bài 3: Benchmark thực tế");
    await expect(page.getByText("Nội dung chưa được cung cấp.")).toBeVisible();
  });

  test("lesson without video shows teacher placeholder", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, "Bài 3: Benchmark thực tế");
    await expect(page.getByText("Chưa có video. Tải video lên để bắt đầu tạo nội dung.")).toBeVisible();
  });

  test("video load error shows error placeholder instead of broken player", async ({ teacherPage: page }) => {
    // Heavy real-video upload + player mount: under parallel load the storage PUT,
    // presigned-URL fetch, and <video> load can run long. Give the whole test
    // generous headroom so a slow-but-healthy run isn't cut off.
    test.setTimeout(120_000);
    const lessonUrl = await createLesson(page, uid("ErrorVideoTest"), "Module 1", uid("Lesson"));
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input (signals
    // the processing tab is hydrated, not just DOM-loaded).
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible({ timeout: 15_000 });
    // Upload a real file so video_storage_key is set in DB
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    // After upload, the workflow advances to the transcript step — confirms upload succeeded.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 60_000 });
    // Navigate to ?tab=content so the server fetches the presigned download URL and renders the video player
    await page.goto(`${lessonUrl}?tab=content`, { waitUntil: "domcontentloaded" });
    // Wait for the player to actually mount as the definitive "ready" signal before
    // asserting on the error placeholder (generous timeout for a slow load under load).
    await expect(page.locator("video").first()).toBeVisible({ timeout: 30_000 });
    // The onError placeholder text must NOT be visible when the video loads fine.
    // Use a short positive timeout so this stays an auto-retrying web-first assertion
    // (the player onError handler may fire slightly after mount); it asserts the
    // placeholder is absent and gives a healthy load a moment to settle.
    await expect(page.getByText("Video không thể tải")).toHaveCount(0, { timeout: 5_000 });
  });
});

// ── 3. Transcript ──────────────────────────────────────────────────────────

test.describe("Transcript display", () => {
  test("seeded lesson shows transcript section", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Seeded lesson has chunks → the "Dàn bài" outline tab is visible in the sidebar.
    // The sidebar shows Big-O chunk summaries in the outline.
    await expect(page.getByRole("button", { name: "Dàn bài", exact: true })).toBeVisible({ timeout: 5000 });
    // Big-O content appears in the chunk outline (chunk summaries)
    await expect(page.getByText(/Big-O/).first()).toBeVisible();
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
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    // Navigate to ?tab=processing so server re-renders with video_key set → AI section appears
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Tạo nội dung từ video")).toBeVisible();
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible();
  });

  test("seeded lesson shows analysis status Hoàn thành", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    // AI pipeline is in ?tab=processing
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Analysis was seeded with status=done; the redesigned lesson overview surfaces it as readiness.
    await expect(page.getByText("Tạo nội dung từ video")).toBeVisible();
    await expect(page.getByTestId("workflow-step-exercises")).toContainText(/\d+ câu/);
    await expect(page.getByText("Đã sẵn sàng dùng thử")).toBeVisible();
    await expect(page.getByTestId("workflow-next-action")).not.toContainText("Trích xuất phiên âm");
  });

  test("teacher sees questions with correct answers highlighted", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    // Questions are in the ?tab=processing tab (exercises step)
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    // After redesign v2: chunks collapse by default — expand first chunk to see interactions
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 5000 });
    await page.getByTestId("chunk-title-bar").first().click();
    // Correct answer options have green border class
    const correctOptions = page.locator(".border-green-500");
    await expect(correctOptions.first()).toBeVisible();
  });
});

// ── 4b. SSE streaming progress UI ─────────────────────────────────────────

test.describe("AI analysis streaming progress", () => {
  test("clicking Trích xuất phiên âm shows 4-step progress panel", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học SSE"), uid("Chương SSE"), uid("Bài SSE"),
    );
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" }).click();

    // Progress panel (the bottom hero card) appears immediately.
    const panel = page.locator('[data-testid="extract-progress"]');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // All 4 step labels present (extract pipeline). Scope to the inner
    // strip so we don't accidentally match the hero card's own title.
    const strip = panel.locator('[data-testid="stream-progress"]');
    await expect(strip.getByText("Tải video từ storage")).toBeVisible();
    await expect(strip.getByText("Trích xuất âm thanh")).toBeVisible();
    await expect(strip.getByText("Đang phiên âm")).toBeVisible();
    await expect(strip.getByText("Lưu kết quả")).toBeVisible();
  });

  test("extract running state surfaces in the hero card (not a duplicate CTA)", async ({ teacherPage: page }) => {
    // The running extract state is the bottom hero card (single
    // source of truth). The next-action panel deliberately hides its
    // running CTA when the user is already on the matching step, so
    // there is no redundant "Đang trích xuất..." button pointing to
    // the step they are already viewing.
    const url = await createLesson(
      page, uid("Khóa học Busy"), uid("Chương Busy"), uid("Bài Busy"),
    );
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" }).click();
    // The hero card is visible with the running state + cancel button.
    const hero = page.locator('[data-testid="extract-progress"]');
    await expect(hero).toBeVisible({ timeout: 5_000 });
    await expect(hero).toContainText("Đang phiên âm");
    await expect(hero.locator('button[data-testid="extract-progress-cancel"]')).toBeVisible();
    // The next-action panel does NOT show the running-state "Đang
    // trích xuất..." CTA when on the matching step.
    const nextAction = page.getByTestId("workflow-next-action");
    if (await nextAction.isVisible().catch(() => false)) {
      await expect(nextAction.getByRole("button", { name: "Đang trích xuất..." })).toHaveCount(0);
    }
  });

  test("extract task survives page reload and recovers progress or result", async ({ teacherPage: page }) => {
    test.setTimeout(600_000);
    const url = await createLesson(
      page, uid("Khóa học Reload Task"), uid("Chương Reload Task"), uid("Bài Reload Task"),
    );
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" }).click();
    await expect(page.locator('[data-testid="extract-progress"]')).toBeVisible({ timeout: 5_000 });

    // Navigate back to ?tab=processing after reload so the pipeline UI is visible
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });

    // Wait for any sign that the extract task is tracked by the UI:
    // - lesson-task-panel (other-step tasks visible in the panel)
    // - extract-progress hero card (task tracker set extractState to running)
    // - "Đang trích xuất..." disabled button in WorkflowNextAction
    // - "Phân đoạn bài học" button (extract already completed)
    // Note: lesson-task-panel hides active tasks when the user is on the
    // matching step (transcript), so it may not appear for the extract task.
    await expect.poll(async () => {
      const panelVisible = await page.getByTestId("lesson-task-panel").first().isVisible();
      const progressVisible = await page.locator('[data-testid="extract-progress"]').first().isVisible();
      const extractingVisible = await page
        .getByTestId("workflow-next-action")
        .getByRole("button", { name: "Đang trích xuất..." })
        .first()
        .isVisible();
      const resultVisible = await page
        .getByRole("button", { name: "Phân đoạn bài học" })
        .first()
        .isVisible();
      return panelVisible || progressVisible || extractingVisible || resultVisible;
    }, { timeout: 60_000 }).toBe(true);

    await expect.poll(async () => {
      const resultVisible = await page
        .getByRole("button", { name: "Phân đoạn bài học" })
        .first()
        .isVisible();
      const errorVisible = await page.locator('[data-testid="extract-error"]').first().isVisible();
      return resultVisible || errorVisible;
    }, { timeout: 360_000 }).toBe(true);
    await expect(page.locator('[data-testid="extract-error"]')).not.toBeVisible();
  });

});

// ── 5. Student quiz form ───────────────────────────────────────────────────

/** Answer every checkpoint (in order) via the video trigger hook. `cps` = the actual
 *  checkpoint start-seconds (from fetchCheckpointSeconds) so this stays correct after
 *  the fixture timeline is fitted to the real video duration. */
async function answerAllCheckpoints(page: Page, cps: number[], optionIndexPerQ?: number[]) {
  for (let i = 0; i < cps.length; i++) {
    await triggerCheckpoint(page, cps[i] + 2);
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
    await ensureRetakeState(page);
    // In fresh state no checkpoint is active → no green borders visible
    await expect(page.locator(".border-green-500")).toHaveCount(0);
  });

  test("student sees previous attempt result (seeded)", async ({ studentPage: page }) => {
    // bob has a seeded attempt for Big-O lesson
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
    // The per-question result strip ("Từng câu") gives a glanceable per-question map.
    const strip = page.getByTestId("result-question-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByText("Từng câu")).toBeVisible();
  });

  test("student can retake quiz: answer all checkpoints + submit → new score", async ({
    studentPage: page,
  }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);

    // "Nộp bài" should not appear until all checkpoints answered
    await expect(page.getByRole("button", { name: "Nộp bài" })).not.toBeVisible();

    await answerAllCheckpoints(page, await fetchCheckpointSeconds(href));

    const submitBtn = page.getByRole("button", { name: "Nộp bài" });
    await expect(submitBtn).toBeEnabled({ timeout: 3_000 });
    await submitBtn.click();

    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Làm lại" })).toBeVisible();
  });

  test("submit button not visible until all questions answered via checkpoints", async ({
    studentPage: page,
  }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);

    // Initially "Nộp bài" not visible
    await expect(page.getByRole("button", { name: "Nộp bài" })).not.toBeVisible();

    // Answer all but the last checkpoint
    const cps = await fetchCheckpointSeconds(href);
    for (let i = 0; i < cps.length - 1; i++) {
      await triggerCheckpoint(page, cps[i] + 2);
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
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);

    // q1 correct_answer=1 per seed; others pick first option
    await answerAllCheckpoints(page, await fetchCheckpointSeconds(href), [1, 0, 0, 0, 0]);

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
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

    // Trigger via test hook (Object.defineProperty on currentTime is unreliable in Firefox)
    await triggerCheckpoint(page, 210);

    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
  });

  test("clicking option in checkpoint shows correct/wrong feedback", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Bob has a seeded attempt (server reveals correct answers) → reset to trigger checkpoints
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

    await triggerCheckpoint(page, 210);

    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });

    // Click any option — AFTER_SUBMIT mode shows acknowledgment (not green/red reveal)
    await checkpoint.locator("button").first().click();
    await expect(checkpoint.getByText("✓ Đã ghi nhận đáp án")).toBeVisible();
  });

  test("checkpoint does not reappear for same question after dismiss", async ({
    studentPage: page,
  }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

    // Trigger JUST the first checkpoint (a value between c1 and c2, so exactly one
    // checkpoint is crossed — otherwise re-triggering would legitimately surface the
    // NEXT gate and this test's premise wouldn't hold).
    const cps = await fetchCheckpointSeconds(href);
    const atFirst = cps[0] + 2;
    await triggerCheckpoint(page, atFirst);
    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });
    await checkpoint.locator("button").first().click();
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(checkpoint).not.toBeVisible();

    // Trigger again at the same time — checkpoint should NOT reappear (already in passedIds)
    await triggerCheckpoint(page, atFirst);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible();
  });

  test("teacher in editing mode does not see checkpoint", async ({ teacherPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.locator("video").first()).toBeVisible();

    await triggerCheckpoint(page, 210);
    // Teacher in editing mode (effectiveCanManage=true) should NOT see quiz checkpoint
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible({ timeout: 2_000 });
  });

  test("teacher in preview mode sees checkpoint", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    await page.goto(`${lessonHref}?preview=1`);
    await expect(page.locator("video").first()).toBeVisible();

    await triggerCheckpoint(page, 210);
    // Teacher in preview mode (isPreview=true) behaves like a student — checkpoint is visible
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 3_000 });
  });

  test("student cannot bypass checkpoint by playing video while quiz shows", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

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
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

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

  test("checkpoint renders as an in-frame overlay, not a separate dialog", async ({
    studentPage: page,
  }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

    await triggerCheckpoint(page, 210);

    // The interaction overlay must be a DOM descendant of the player frame, so it
    // stays INSIDE the video in both normal and fullscreen — not a body-portalled
    // dialog (the bug: in fullscreen it dropped below; in normal it popped a dialog).
    const frame = page.getByTestId("lesson-player-frame");
    await expect(frame.getByTestId("quiz-checkpoint-overlay")).toBeVisible({ timeout: 3_000 });
    await expect(frame.locator('[data-testid="quiz-checkpoint"]')).toBeVisible();
    // No portalled Radix dialog is used for the checkpoint.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test("student can seek forward up to the next unanswered checkpoint", async ({
    studentPage: page,
  }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();

    // Seeking to just BEFORE the first checkpoint is ALLOWED — the gate only blocks
    // crossing an unanswered checkpoint, not seeking up to it.
    const cps = await fetchCheckpointSeconds(href);
    const firstGate = cps[0];
    const before = Math.max(2, firstGate - 30);
    await page.evaluate((t) => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (v) v.currentTime = t;
    }, before);
    await page.waitForTimeout(600);

    const time = await page.evaluate(
      () => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? 0,
    );
    // Stays where we put it, NOT snapped forward to the gate.
    expect(time).toBeGreaterThan(before - 5);
    expect(time).toBeLessThan(firstGate);
    // No checkpoint shown — we stopped short of it.
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible();
  });

  // Regression (teacher preview): seeking FORWARD past one or more unanswered
  // checkpoints must clamp to the nearest one — and after answering it, playback
  // resumes FROM that checkpoint, NOT the seek target. Previously preview skipped the
  // seek guard, so the video sat at the target and jumped there on continue, bypassing
  // the gate (and any checkpoints in between). Preview must mirror the student.
  test("teacher preview: forward-seek past checkpoints clamps to the nearest and resumes there", async ({
    teacherPage: page,
  }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    const cps = await fetchCheckpointSeconds(lessonHref);
    const [c1, c2] = cps; // first two (real, fitted) checkpoint times
    await page.goto(`${lessonHref}?preview=1`);
    await expect(page.locator("video").first()).toBeVisible();

    // Leave the initial-load state so the seek guard engages (it ignores the mount
    // seek). Nothing is before c1, so no checkpoint surfaces here.
    await triggerCheckpoint(page, 5);
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible({ timeout: 1_500 });

    // Seek WELL past BOTH the first (c1) and second (c2) checkpoints (still inside the video).
    const target = c2 + (c2 - c1) + 20;
    await page.evaluate((t) => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (v) v.currentTime = t;
    }, target);

    // The guard snaps the video back to the FIRST unanswered checkpoint (c1), not the
    // target, and surfaces it.
    const clampLimit = c1 + 40;
    await page.waitForFunction(
      (limit) => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        return !v || v.currentTime < limit;
      },
      clampLimit,
      { timeout: 5_000 },
    );
    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(checkpoint).toBeVisible({ timeout: 3_000 });
    expect(
      await page.evaluate(
        () => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? 0,
      ),
    ).toBeLessThan(clampLimit);

    // Answer the first checkpoint and continue.
    await checkpoint.locator("button").first().click();
    await page.getByRole("button", { name: "Tiếp tục xem" }).click();
    await expect(checkpoint).not.toBeVisible({ timeout: 3_000 });

    // After answering, playback resumes FROM c1 — it must NOT jump to the seek target
    // (which would skip the c2 checkpoint). This is the bug.
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(
        () => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? 0,
      ),
    ).toBeLessThan(c2);
  });

  // Regression: a checkpoint whose start_seconds sits PAST the real video duration
  // (real-analysis chunk boundaries that overshoot the audio, or legacy data) must
  // still surface on video END — otherwise the learner can never answer it and can
  // never complete the lesson (allAnswered stays false, "Nộp bài" never enables).
  test("checkpoint past the video duration still surfaces on video end", async ({
    teacherPage: page,
  }) => {
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    await createInteraction(token, lessonId, {
      kind: InteractionKind.SINGLE_CHOICE,
      startSeconds: 99999, // far past any test video
      prompt: "Câu hỏi cuối (quá thời lượng video)",
    });
    // Preview mode renders the student player (StudentLessonView) with checkpoint gating.
    await page.goto(`${lessonUrl}?preview=1`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("video").first()).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    // Not reachable by playback → no checkpoint yet.
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).not.toBeVisible({ timeout: 1_500 });
    // Simulate the video reaching its end. Re-dispatch until it takes, to avoid a
    // race with the client hydrating the ended handler / interactions state.
    const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
    await expect(async () => {
      await page.evaluate(() => document.querySelector("video")?.dispatchEvent(new Event("ended")));
      await expect(checkpoint).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 12_000 });
  });

  // Runtime timing: the LAST chunk's checkpoint must fire from REAL playback reaching
  // it (not just via the trigger hook) — the "miss chunk cuối" concern. Answer every
  // earlier checkpoint, then play into the final chunk and assert its question surfaces.
  test("last chunk's checkpoint fires during real playback (not missed)", async ({
    studentPage: page,
  }) => {
    const href = await goToSeededLesson(page, SEEDED_LESSON);
    await ensureRetakeState(page);
    await expect(page.locator("video").first()).toBeVisible();
    const cps = await fetchCheckpointSeconds(href);
    const last = cps[cps.length - 1];
    // Clear every checkpoint EXCEPT the last, so only the final gate remains.
    for (let i = 0; i < cps.length - 1; i++) {
      await triggerCheckpoint(page, cps[i] + 2);
      const cp = page.locator('[data-testid="quiz-checkpoint"]');
      await expect(cp).toBeVisible({ timeout: 5_000 });
      await cp.locator("button").first().click();
      await page.getByRole("button", { name: "Tiếp tục xem" }).click();
      await expect(cp).not.toBeVisible({ timeout: 3_000 });
    }
    // Real playback into the final chunk: seek to just before the last checkpoint and play.
    await page.evaluate((t) => {
      const v = document.querySelector("video") as HTMLVideoElement | null;
      if (v) { v.pause(); v.muted = true; v.currentTime = t; void v.play(); }
    }, Math.max(1, last - 6));
    // The final chunk's checkpoint surfaces as playback reaches it.
    await expect(page.locator('[data-testid="quiz-checkpoint"]')).toBeVisible({ timeout: 15_000 });
  });
});

// ── 9. Teacher student progress ────────────────────────────────────────────

test.describe("Student progress (teacher view)", () => {
  test("teacher sees progress table with seeded attempts", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    // Attempts table is in the ?tab=results tab; navigate there directly
    await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Bảng kết quả học viên")).toBeVisible();

    // bob and dave both have seeded attempts for Big-O lesson
    const attemptsSection = page.getByTestId("lesson-attempts");
    await expect(attemptsSection).toBeVisible();
    // Table should show at least one row (bob's attempt)
    await expect(attemptsSection.getByText(/bob@dyadia.local|dave@dyadia.local/).first()).toBeVisible();
  });

  test("progress table shows score with color coding", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEEDED_LESSON);
    // Attempts table is in the ?tab=results tab; navigate there directly
    await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });
    const attemptsSection = page.getByTestId("lesson-attempts");
    // Score column should be visible
    await expect(attemptsSection.getByText(/\d+\/\d+/).first()).toBeVisible();
  });

  test("new lesson has empty attempts table", async ({ teacherPage: page }) => {
    const url = await createLesson(
      page, uid("Khóa học Empty Progress"), uid("Chương Empty"), uid("Bài Empty"),
    );
    // Attempts table is in the ?tab=results tab; navigate there directly
    await page.goto(`${url}?tab=results`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Bảng kết quả học viên")).toBeVisible();
    await expect(page.getByText("Chưa có học viên nào nộp bài.")).toBeVisible();
  });
});

// ── 10. Interactive transcript ────────────────────────────────────────────

test.describe("Interactive transcript (seeded segments)", () => {
  // Note: seeded lessons have chunks (outline) seeded in postgres; the transcript
  // text lives in FDB. The sidebar shows the "Dàn bài" outline by default when chunks exist.
  test("plain transcript renders for seeded lesson", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Seeded lesson has chunks → sidebar shows "Dàn bài" outline with Big-O content.
    // Use exact:true to avoid strict-mode collision with "Thu gọn dàn bài" button.
    await expect(page.getByRole("button", { name: "Dàn bài", exact: true })).toBeVisible({ timeout: 5000 });
    // Chunk summaries in the outline contain Big-O related text
    await expect(page.getByText(/Big-O/).first()).toBeVisible();
  });

  test("seek hint shown only when segments exist", async ({ studentPage: page }) => {
    await goToSeededLesson(page, SEEDED_LESSON);
    // Seeded lesson has no transcript_segments → hint should NOT appear
    await expect(page.getByText("(nhấn vào đoạn để tua video)")).not.toBeVisible();
  });
});

// ── 4c. Full pipeline with audio fixture ─────────────────────────────────────
// Tests in this block require: edu-sample.mp4, AI services running in the
// test environment. They run serially so extraction happens only once, with the
// lesson URL shared across tests via a block-scoped variable.

test.describe.serial("Full pipeline with audio fixture", () => {
  let lessonUrl = "";

  test("pipeline: upload audio video → extract → chunk → generate questions", async ({ teacherPage: page }) => {
    test.setTimeout(600_000);
    lessonUrl = await createLesson(
      page, uid("Pipeline Course"), uid("Pipeline Module"), uid("Pipeline Lesson"),
    );
    // Upload controls live in the ?tab=processing tab
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input
    await expect(page.getByRole("button", { name: "Tải video lên" }).first()).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    // After upload, the workflow advances to the transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible({ timeout: 30_000 });

    // Step 1: Extract transcript
    await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" }).click();
    // The running extract state is shown in the bottom hero card.
    const extractHero = page.locator('[data-testid="extract-progress"]');
    await expect(extractHero).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: "Phân đoạn bài học" }).or(page.locator('[data-testid="extract-error"]')),
    ).toBeVisible({ timeout: 360_000 });
    await expect(page.locator('[data-testid="extract-error"]')).not.toBeVisible();
    await expect(page.getByTestId("workflow-step-body")).toContainText("Phân đoạn bài học");
    await expect(page.getByText("Tác vụ phân đoạn")).not.toBeVisible();

    // Step 2: Chunk transcript. After extract the workflow advances to the chunks
    // step, where the single chunk CTA lives in ChunkReadyState (the duplicate
    // WorkflowNextAction CTA was removed); match by accessible name either way.
    await page.getByTestId("workflow-step-chunks").click();
    await page.getByRole("button", { name: "Phân đoạn bài học" }).first().click();
    // The running chunk state is shown in the bottom hero card.
    const chunkHero = page.locator('[data-testid="chunk-progress"]');
    await expect(chunkHero).toBeVisible({ timeout: 10_000 });
    // Navigate back to ?tab=processing after reload so the pipeline UI is visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      const taskPanelVisible = await page.getByTestId("lesson-task-panel").first().isVisible();
      const progressVisible = await page.locator('[data-testid="chunk-progress"]').first().isVisible();
      const readyVisible = await page.getByRole("button", { name: /Bắt đầu tạo|Tạo thêm/ }).first().isVisible();
      return taskPanelVisible || progressVisible || readyVisible;
    }, { timeout: 30_000 }).toBe(true);
    await expect(
      page.getByRole("button", { name: /Bắt đầu tạo|Tạo thêm/ }).or(page.locator('[data-testid="chunk-error"]')).first(),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('[data-testid="chunk-error"]')).not.toBeVisible();
    await expect(page.getByTestId("workflow-step-body")).toContainText("Tạo bài tập");

    // Step 3: Generate questions
    await page.getByTestId("workflow-step-exercises").click();
    await page.getByRole("button", { name: /Bắt đầu tạo|Tạo thêm/ }).click();
    // Fill the custom AI configuration to verify custom generation payload mapping.
    // The dialog now defaults every kind to 0 (managers choose explicitly), so each
    // of the five kinds is bumped to 1 here → "Tạo 5 bài tập".
    await page.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();
    await page.getByRole("button", { name: "Tăng Trắc nghiệm nhiều đáp án" }).click();
    await page.getByRole("button", { name: "Tăng Điền đáp án" }).click();
    await page.getByRole("button", { name: "Tăng Bài đọc" }).click();
    await page.getByRole("button", { name: "Tăng Bài nghe" }).click();
    await page.getByRole("button", { name: /Khó/ }).click();
    await page.locator("#gen-focus-prompt").fill("Tập trung vào cấu trúc dữ liệu Giải thuật và Big O");
    await page.getByRole("button", { name: "Tạo 5 bài tập" }).click();
    await expect(page.getByText("Đang tạo bài tập")).toBeVisible({ timeout: 5_000 });
    // Navigate back to ?tab=processing after reload so the pipeline UI is visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      const taskPanelVisible = await page.getByTestId("lesson-task-panel").first().isVisible();
      const generatingVisible = await page.getByText("Đang tạo bài tập").first().isVisible();
      const readyVisible = await page.getByText("Đã sẵn sàng dùng thử").first().isVisible();
      return taskPanelVisible || generatingVisible || readyVisible;
    }, { timeout: 30_000 }).toBe(true);
    await expect(
      page.getByText("Đã sẵn sàng dùng thử").or(page.locator('[data-testid="gen-error"]')),
    ).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('[data-testid="gen-error"]')).not.toBeVisible();
    await expect(page.getByTestId("workflow-step-preview")).toContainText("Sẵn sàng");
    // Navigate to exercises step and expand all chunks to reveal interaction type badges.
    // Chunks collapse by default; the type badges live inside the expanded interaction rows.
    await page.getByTestId("workflow-step-exercises").click();
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 5_000 });
    for (const bar of await page.getByTestId("chunk-title-bar").all()) {
      await bar.click();
    }
    const stepBody = page.getByTestId("workflow-step-body");
    // The interaction row renderer labels (from src/interactions/*/index.ts):
    // SINGLE_CHOICE → "Trắc nghiệm một đáp án", MULTIPLE_CHOICE → "Trắc nghiệm nhiều đáp án"
    await expect(stepBody.getByText("Trắc nghiệm một đáp án").first()).toBeVisible({ timeout: 10_000 });
    await expect(stepBody.getByText("Trắc nghiệm nhiều đáp án").first()).toBeVisible();
    await expect(stepBody.getByText("Điền đáp án").first()).toBeVisible();
    await expect(stepBody.getByText("Bài đọc").first()).toBeVisible();
    await expect(stepBody.getByText("Bài nghe").first()).toBeVisible();
  });

  test("after pipeline: transcript segments visible with seek hint", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    // Transcript segment editor is in ?tab=processing; the interactive transcript display is in
    // ?tab=content. This test verifies the content tab shows the segments after the pipeline.
    await page.goto(`${lessonUrl}?tab=content`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Phiên âm nội dung")).toBeVisible();
    await expect(page.getByText("(nhấn vào đoạn để tua video)")).toBeVisible();
    await expect(page.locator('[data-testid="interactive-transcript"]')).toBeVisible();
    await expect(page.locator('[data-testid^="transcript-segment-"]').first()).toBeVisible();
  });

  test("after pipeline: clicking transcript segment seeks video", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    // Interactive transcript with seek functionality is in ?tab=content (VideoPlayer sidebar)
    await page.goto(`${lessonUrl}?tab=content`, { waitUntil: "domcontentloaded" });

    const firstSeg = page.locator('[data-testid="transcript-segment-0"]');
    await expect(firstSeg).toBeVisible({ timeout: 5_000 });

    const startSec = parseFloat((await firstSeg.getAttribute("data-start-seconds")) ?? "0");
    await firstSeg.click();

    const videoTime = await page.evaluate(
      () => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? -1,
    );
    expect(videoTime).toBeGreaterThanOrEqual(startSec - 0.5);
  });

  test("after pipeline: transcript chunks visible in Phân đoạn step", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    // Chunk editor is in ?tab=processing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });

    await page.getByTestId("workflow-step-chunks").click();
    // PipelineStep 1 "Phân đoạn lại" is collapsed after pipeline (defaultOpen={!hasChunks}=false).
    // Expand it first so children are rendered in the DOM.
    await page.getByLabel("Mở rộng").first().click();
    await expect(page.getByRole("button", { name: /Phân đoạn lại/ })).toBeVisible({ timeout: 5_000 });
  });

  test("after pipeline: status shows Hoàn thành", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    // "Đã sẵn sàng dùng thử" is shown in the workflow-next-action panel in ?tab=processing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Đã sẵn sàng dùng thử")).toBeVisible({ timeout: 5_000 });
  });

  test("after pipeline: 'Trích xuất lại' button visible when segments exist", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    // Transcript extract button is in ?tab=processing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-transcript").click();
    // After pipeline, lesson has transcript segments → extract button shows "Trích xuất lại"
    await expect(page.getByRole("button", { name: "Trích xuất lại" })).toBeVisible({ timeout: 5_000 });
  });

  test("editing transcript segment updates VideoPlayer transcript display", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    // Start on ?tab=processing to access segment editing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });

    // Open the "Phiên âm" workflow step in AnalyzeButton to access segment editing.
    await page.getByTestId("workflow-step-transcript").click();
    // Wait for the SegmentRow editor to be ready — "Chỉnh sửa" button indicates segments are rendered.
    // NOTE: transcript-segment-N testids live in the ?tab=content VideoPlayer sidebar (InteractiveTranscript),
    // not in the processing tab's SegmentRow editor. Checking the edit button is the correct precondition.
    await expect(page.getByTitle("Chỉnh sửa").first()).toBeVisible({ timeout: 5_000 });

    // Edit the first segment
    const newText = uid("Đoạn đã sửa");
    await page.getByTitle("Chỉnh sửa").first().click();
    const textarea = page.locator("textarea").first();
    await textarea.clear();
    await textarea.fill(newText);
    await page.getByTitle("Lưu").first().click();

    // After save, the updated segment text appears in the SegmentRow <p> within the step body.
    // Scope to workflow-step-body to avoid matching text in hidden sidebar elements.
    await expect(page.getByTestId("workflow-step-body").getByText(newText).first()).toBeVisible({
      timeout: 10_000,
    });

    // Wait for router.refresh() (triggered by SegmentRow.onSaved) to settle before navigating.
    // Firefox throws NS_BINDING_ABORTED if we navigate while the RSC refresh is still in flight.
    await page.waitForLoadState("domcontentloaded");

    // Verify the VideoPlayer (content tab) also shows the updated segment text. The
    // segment save triggers a router.refresh(); under parallel load that soft refresh
    // can race the navigation (Firefox aborts it with NS_BINDING_ABORTED), landing on
    // a stale render. Re-navigate until the fresh server render — which reads the saved
    // segment from the DB — shows the new text.
    await expect(async () => {
      await page.goto(`${lessonUrl}?tab=content`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await expect(page.locator('[data-testid="interactive-transcript"]')).toBeVisible({ timeout: 3_000 });
      await expect(page.locator('[data-testid="transcript-segment-0"]').first()).toContainText(newText, {
        timeout: 3_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  // NOTE: this test must run before "after video replacement" — the replacement
  // wipes chunks/transcript and resets status to PENDING, which locks the "Phân đoạn lại"
  // PipelineStep and hides the "Mở rộng" toggle button this test relies on.
  test("chunk step labels appear during ChunkTranscriptStream", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    test.setTimeout(300_000);
    // The pipeline lesson has a complete transcript — re-run chunking to observe progress labels.
    // Chunk editor is in ?tab=processing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });

    // Navigate to the "Phân đoạn" workflow step where the "Phân đoạn lại" button lives.
    await page.getByTestId("workflow-step-chunks").click();
    // PipelineStep 1 is collapsed after pipeline — expand it so the button is in the DOM
    await page.getByLabel("Mở rộng").first().click();
    await page.getByRole("button", { name: "Phân đoạn lại" }).click();

    const chunkPanel = page.locator('[data-testid="chunk-progress"]');
    await expect(chunkPanel).toBeVisible({ timeout: 10_000 });
    await expect(chunkPanel.getByText("Đang phân đoạn nội dung")).toBeVisible();
    await expect(chunkPanel.getByText("Lưu các đoạn")).toBeVisible();

    // Wait for the re-chunk to actually finish so subsequent tests in this block
    // see chunks (not an empty list during the in-flight task). Re-chunking
    // intentionally clears generated exercises and moves the workflow to the
    // exercise step, so the stable completion signal is the AI-create button.
    await expect(
      page.getByRole("button", { name: /Bắt đầu tạo|Tạo thêm/ }).or(page.locator('[data-testid="chunk-error"]')).first(),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('[data-testid="chunk-error"]')).not.toBeVisible();
  });

  test("after video replacement: transcript state and VideoPlayer clear", async ({ teacherPage: page }) => {
    if (!lessonUrl) throw new Error("Pipeline setup failed — lessonUrl not set by test 1");
    test.setTimeout(60_000);
    // Start on ?tab=processing: pipeline ran → transcript sections and video upload controls visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });

    // Pre-condition: pipeline ran → transcript section is accessible in the processing tab.
    // transcript-segment-N testids live in InteractiveTranscript (?tab=content), not in the SegmentRow
    // editor (?tab=processing). Check for the "Chỉnh sửa" button to verify segments are loaded.
    await page.getByTestId("workflow-step-transcript").click();
    await expect(page.getByTitle("Chỉnh sửa").first()).toBeVisible({ timeout: 5_000 });

    // Switch to content tab to confirm the interactive transcript is present before replacement
    await page.goto(`${lessonUrl}?tab=content`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Phiên âm nội dung")).toBeVisible();
    await expect(page.locator('[data-testid="interactive-transcript"]')).toBeVisible();
    const oldVideoSrc = await page.locator('[data-testid="video-player"] video').getAttribute("src");
    expect(oldVideoSrc).toBeTruthy();

    // Go back to ?tab=processing, open Step 1 (Upload) to mount the VideoUpload component
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-upload").click();

    // Upload a replacement video (same format, triggers status → PENDING)
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO);

    // AnalyzeButton state reset: button reverts to "Trích xuất phiên âm" (not "Trích xuất lại")
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất phiên âm" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trích xuất lại" })).not.toBeVisible();

    // Navigate to ?tab=content to confirm the VideoPlayer source changed and transcript cleared
    await page.goto(`${lessonUrl}?tab=content`, { waitUntil: "domcontentloaded" });
    // VideoPlayer transcript section should disappear (status → PENDING, FDB cleared)
    await expect(page.getByText("Phiên âm nội dung")).not.toBeVisible({ timeout: 10_000 });
    // The actual media source changes after replacement
    await expect.poll(
      async () => page.locator('[data-testid="video-player"] video').getAttribute("src"),
      { timeout: 10_000 },
    ).not.toBe(oldVideoSrc);
  });
});

// ── 11. Teacher question editing ──────────────────────────────────────────────
// Uses a fresh analyzed lesson (created in beforeAll) so that edits/adds/deletes
// never touch the shared seeded Big-O lesson and can run in parallel with other files.

test.describe.serial("Teacher question editing", () => {
  // Shared across all tests in this describe block.
  let editingLessonUrl = "";
  let editingLessonId = "";
  let editingToken = "";

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const result = await createAnalyzedLesson();
    editingLessonUrl = result.lessonUrl;
    editingLessonId = result.lessonId;
    editingToken = result.token;

    // Seed two interactions so the exercises step has visible questions for edit/cancel tests.
    for (let i = 0; i < 2; i++) {
      await createInteraction(
        editingToken,
        editingLessonId,
        {
          kind: InteractionKind.SINGLE_CHOICE,
          startSeconds: (i + 1) * 5,
          prompt: `Câu hỏi khởi tạo ${i + 1}`,
        },
      );
    }
  });

  test("teacher sees edit/delete buttons on each question", async ({ teacherPage: page }) => {
    // Question editor is in the ?tab=processing tab (exercises step)
    await page.goto(`${editingLessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    // Chunks collapse by default — expand first chunk to see interactions.
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 5000 });
    await page.getByTestId("chunk-title-bar").first().click();

    // First question row should have edit and delete icons.
    await expect(page.getByTitle("Chỉnh sửa").first()).toBeVisible();
    await expect(page.getByTitle("Xóa").first()).toBeVisible();
  });

  test("teacher can edit a question inline", async ({ teacherPage: page }) => {
    // Question editor is in the ?tab=processing tab (exercises step)
    await page.goto(`${editingLessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    // Chunks collapse by default — expand first chunk to see interactions.
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 5000 });
    await page.getByTestId("chunk-title-bar").first().click();

    // Open edit for first question.
    await page.getByTitle("Chỉnh sửa").first().click();
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();

    // Change the question text.
    const newText = uid("Câu hỏi đã sửa");
    await textarea.fill(newText);
    await page.getByRole("button", { name: "Lưu" }).first().click();

    // Edit form closes and new text appears — scope to the step body so we match the visible
    // question paragraph, not the hidden chunk-title-bar preview span.
    await expect(page.locator("textarea").first()).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("workflow-step-body").getByText(newText).first()).toBeVisible();
  });

  test("teacher can add a manual question", async ({ teacherPage: page }) => {
    // Question editor is in the ?tab=processing tab (exercises step)
    await page.goto(`${editingLessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    // Wait for chunk cards to appear (exercises step fully loaded).
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 10000 });

    await page.getByTestId("add-interaction-btn").first().click();
    // Inline form opens with single-choice selected by default.
    await expect(page.getByRole("button", { name: "Trắc nghiệm 1 đáp án", exact: true })).toBeVisible();

    // Fill in the add form.
    await page.getByPlaceholder("Nhập câu hỏi...").fill("Câu hỏi thủ công mới");
    await page.getByPlaceholder("Lựa chọn A", { exact: true }).fill("Phương án A");
    await page.getByPlaceholder("Lựa chọn B", { exact: true }).fill("Phương án B");
    await page.getByPlaceholder("Lựa chọn C", { exact: true }).fill("Phương án C");
    await page.getByPlaceholder("Lựa chọn D", { exact: true }).fill("Phương án D");
    // Single choice no longer auto-marks option A (server rejects correct_answer < 0).
    await page.getByTitle("Chọn làm đáp án đúng").first().click();

    await page.getByRole("button", { name: "Lưu" }).last().click();
    // Scope to step body to match the visible paragraph row, not hidden title bar preview.
    await expect(page.getByTestId("workflow-step-body").getByText("Câu hỏi thủ công mới").first()).toBeVisible({ timeout: 5_000 });
  });

  test("bug 1.8: adding 3 questions consecutively keeps all of them visible", async ({ teacherPage: page }) => {
    // Question editor is in the ?tab=processing tab (exercises step)
    await page.goto(`${editingLessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    // Wait for chunk cards to appear (exercises step fully loaded).
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 10_000 });

    const stamp = uid("");
    const q = (n: number) => `Bug18-${n}-${stamp}`;

    async function addMcq(question: string) {
      await page.getByTestId("add-interaction-btn").first().click();
      await page.getByPlaceholder("Nhập câu hỏi...").fill(question);
      await page.getByPlaceholder("Lựa chọn A", { exact: true }).fill("A");
      await page.getByPlaceholder("Lựa chọn B", { exact: true }).fill("B");
      await page.getByPlaceholder("Lựa chọn C", { exact: true }).fill("C");
      await page.getByPlaceholder("Lựa chọn D", { exact: true }).fill("D");
      // Single choice no longer auto-marks option A (server rejects correct_answer < 0),
      // so pick a correct answer before saving.
      await page.getByTitle("Chọn làm đáp án đúng").first().click();
      await page.getByRole("button", { name: "Lưu" }).last().click();
      // Wait for form to close.
      await expect(page.getByPlaceholder("Nhập câu hỏi...")).not.toBeVisible({ timeout: 5_000 });
    }

    // After each addMcq, the chunk auto-expands (openAdd calls onToggle when collapsed).
    // The expanded interaction list shows questions as paragraphs; the chunk title bar
    // preview span is hidden when expanded. Scope to workflow-step-body to match only
    // the visible paragraph rows.
    const stepBody = page.getByTestId("workflow-step-body");

    await addMcq(q(1));
    await expect(stepBody.getByText(q(1)).first()).toBeVisible({ timeout: 5_000 });

    await addMcq(q(2));
    // Both questions must be visible — regression: stale closure would drop q(1)
    await expect(stepBody.getByText(q(1)).first()).toBeVisible({ timeout: 5_000 });
    await expect(stepBody.getByText(q(2)).first()).toBeVisible({ timeout: 5_000 });

    await addMcq(q(3));
    await expect(stepBody.getByText(q(1)).first()).toBeVisible({ timeout: 5_000 });
    await expect(stepBody.getByText(q(2)).first()).toBeVisible({ timeout: 5_000 });
    await expect(stepBody.getByText(q(3)).first()).toBeVisible({ timeout: 5_000 });
  });

  test("teacher can delete a question", async ({ teacherPage: page }) => {
    // Question editor is in the ?tab=processing tab (exercises step)
    await page.goto(`${editingLessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 5000 });

    // Add a unique question so the delete is self-contained.
    const deleteTarget = uid("Câu hỏi tạm xóa");
    await page.getByTestId("add-interaction-btn").first().click();
    await page.getByPlaceholder("Nhập câu hỏi...").fill(deleteTarget);
    await page.getByPlaceholder("Lựa chọn A", { exact: true }).fill("A");
    await page.getByPlaceholder("Lựa chọn B", { exact: true }).fill("B");
    await page.getByPlaceholder("Lựa chọn C", { exact: true }).fill("C");
    await page.getByPlaceholder("Lựa chọn D", { exact: true }).fill("D");
    // Single choice no longer auto-marks option A (server rejects correct_answer < 0).
    await page.getByTitle("Chọn làm đáp án đúng").first().click();
    await page.getByRole("button", { name: "Lưu" }).last().click();
    await expect(page.getByText(deleteTarget)).toBeVisible({ timeout: 5_000 });

    // Delete the row we just created — scoped by unique text.
    const row = page.getByTestId("interaction-row").filter({ hasText: deleteTarget });
    await row.getByTitle("Xóa").click();
    // Scope to the workflow step body to avoid matching the video player's
    // question marker (which may still show the text briefly).
    await expect(page.getByTestId("workflow-step-body").getByText(deleteTarget)).not.toBeVisible({ timeout: 5_000 });
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
    // Question editor is in the ?tab=processing tab (exercises step)
    await page.goto(`${editingLessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow-step-exercises").click();
    // Chunks collapse by default — expand first chunk to see interactions.
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 5000 });
    await page.getByTestId("chunk-title-bar").first().click();

    // Open edit first to read the original question text from the textarea.
    await page.getByTitle("Chỉnh sửa").first().click();
    const textarea = page.locator("textarea").first();
    const questionText = await textarea.inputValue();
    await textarea.fill("Đây là thay đổi bị hủy");
    await page.getByRole("button", { name: "Hủy" }).first().click();

    // Original text still shown — scope to the step body so we match the visible
    // question paragraph, not the hidden chunk-title-bar preview span.
    await expect(page.getByTestId("workflow-step-body").getByText(questionText ?? "").first()).toBeVisible();
    await expect(page.getByText("Đây là thay đổi bị hủy")).not.toBeVisible();
  });
});
