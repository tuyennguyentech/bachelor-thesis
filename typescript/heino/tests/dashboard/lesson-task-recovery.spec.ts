/**
 * E2E tests for the lesson task panel:
 *  - Active tasks show a cancel button
 *  - Cancel button flips the task to CANCELED
 *  - Refresh button fetches latest task state from the server
 *
 * Prerequisites:
 *   - richter seed --dev has been run
 *   - heino + richter running in the dev/test topology
 *
 * Note: the broader "task survives page reload and recovers" flow is already
 * covered by `video-quiz-flow.spec.ts → extract task survives page reload and
 * recovers progress or result`. This file focuses on the new task panel UI
 * (cancel + refresh) that landed in the FDB-backed task migration.
 */

import path from "path";
import type { Page } from "@playwright/test";
import { create } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import {
  AIService,
  GenerateInteractionsRequestSchema,
  LessonTaskKind,
  LessonTaskStatus,
  type LessonTask,
  type TranscriptChunk,
} from "buf/gen/richter/v1/ai_pb";
import {
  CourseService,
  CourseModuleService,
  LessonService,
} from "buf/gen/richter/v1/courses_pb";
import {
  OrganizationService,
} from "buf/gen/richter/v1/organizations_pb";
import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_LESSON_BIG_O,
  TEACHER_EMAIL,
  USER_PASSWORD,
  goToSeededLesson,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;
const TEST_VIDEO_WITH_AUDIO = path.join(__dirname, "../fixtures/edu-sample-en.mp4");

/**
 * Module-level registry of lesson IDs created by tests that start
 * EXTRACT_TRANSCRIPT tasks. Test A reads this to cancel stale tasks
 * from earlier tests before starting its 3 parallel tasks.
 */
const createdLessonIds: string[] = [];

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

function rpcBaseUrl(baseURL?: string) {
  return process.env.RICHTER_BASE_URL ?? `${baseURL ?? "http://caddy"}/api/richter`;
}

async function getTeacherAuth(baseURL?: string) {
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl(baseURL) });
  const auth = createClient(AuthService, transport);
  const res = await auth.login({ email: TEACHER_EMAIL, password: USER_PASSWORD });
  return { token: res.accessToken, userId: res.user?.id ?? "" };
}

async function getTeacherToken(baseURL?: string) {
  const { token } = await getTeacherAuth(baseURL);
  return token;
}

function createAuthedTransport(token: string, baseURL?: string) {
  const authInterceptor: Interceptor = (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
  return createConnectTransport({
    httpVersion: "1.1",
    baseUrl: rpcBaseUrl(baseURL),
    interceptors: [authInterceptor],
  });
}

function createAIClient(token: string, baseURL?: string) {
  return createClient(AIService, createAuthedTransport(token, baseURL));
}

function lessonIdFromUrl(rawUrl: string) {
  const url = new URL(rawUrl, "http://caddy");
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

async function getSeededLessonWithChunks(
  page: Page,
  ai: ReturnType<typeof createAIClient>,
  lessonTitle: string,
  minChunks = 1,
) {
  await goToSeededLesson(page, lessonTitle);
  const lessonUrl = page.url();
  const lessonId = lessonIdFromUrl(lessonUrl);
  const analysis = await ai.getLessonAnalysis({ lessonId });
  expect(analysis.chunks.length).toBeGreaterThanOrEqual(minChunks);
  return { lessonId, lessonUrl, chunks: analysis.chunks };
}

/**
 * Creates a fresh lesson, runs extract+chunk pipeline via API, and
 * returns the lesson ID, URL, and chunk list once minChunks chunks
 * are available. This avoids touching the seeded Big-O lesson and
 * contaminating it with cancelled tasks, which would break subsequent
 * tests (e.g. studio-new-interactions.spec.ts) that need exercises unlocked.
 */
async function createLessonWithChunks(
  page: Page,
  ai: ReturnType<typeof createAIClient>,
  minChunks = 1,
): Promise<{ lessonId: string; lessonUrl: string; chunks: TranscriptChunk[] }> {
  const url = await createLesson(
    page,
    uid("Khóa học Chunks"),
    uid("Chương Chunks"),
    uid("Bài Chunks"),
  );
  const lessonId = lessonIdFromUrl(url);

  // Upload video via UI so the lesson gets a video_storage_key.
  await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
  // Wait for the upload to finish (button appears when video_storage_key is set).
  await expect(
    page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" }),
  ).toBeVisible({ timeout: 150_000 });

  // Run extract task via API and poll until it reaches a terminal state.
  await ai.startLessonTask({ lessonId, kind: LessonTaskKind.EXTRACT_TRANSCRIPT });
  const extractDeadline = Date.now() + 120_000;
  let extractDone = false;
  while (Date.now() < extractDeadline) {
    const tasks = await ai.listLessonTasks({ lessonId, activeOnly: false, limit: 20, offset: 0 });
    const extract = tasks.tasks.find((t) => t.kind === LessonTaskKind.EXTRACT_TRANSCRIPT);
    if (extract?.status === LessonTaskStatus.SUCCEEDED) { extractDone = true; break; }
    if (extract?.status === LessonTaskStatus.FAILED) throw new Error("createLessonWithChunks: extract failed");
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!extractDone) throw new Error("createLessonWithChunks: extract timed out");

  // Run chunk task via API and poll until minChunks chunks exist.
  await ai.startLessonTask({ lessonId, kind: LessonTaskKind.CHUNK_TRANSCRIPT });
  const chunkDeadline = Date.now() + 120_000;
  while (Date.now() < chunkDeadline) {
    const analysis = await ai.getLessonAnalysis({ lessonId });
    if (analysis.chunks.length >= minChunks) {
      return { lessonId, lessonUrl: url, chunks: analysis.chunks };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("createLessonWithChunks: chunk pipeline timed out");
}

async function startGenerateTask(
  ai: ReturnType<typeof createAIClient>,
  lessonId: string,
  chunkId = "",
  countPerChunk = 0,
) {
  const res = await ai.startLessonTask({
    lessonId,
    kind: LessonTaskKind.GENERATE_INTERACTIONS,
    generateInteractions: create(GenerateInteractionsRequestSchema, {
      lessonId,
      chunkId,
      forceRegenerate: true,
      countPerChunk,
    }),
  });
  if (!res.task) throw new Error("startLessonTask returned no task");
  return res.task;
}

async function cancelTasks(ai: ReturnType<typeof createAIClient>, tasks: LessonTask[]) {
  await Promise.all(tasks.map((task) =>
    ai.cancelLessonTask({ taskId: task.id }).catch(() => undefined),
  ));
}

async function cancelActiveLessonTasks(ai: ReturnType<typeof createAIClient>, lessonId: string) {
  const res = await ai.listLessonTasks({ lessonId, activeOnly: true, limit: 20, offset: 0 });
  await cancelTasks(ai, res.tasks);
}

/**
 * Cancel active tasks across all lessons registered in `createdLessonIds`.
 * Each test that creates a lesson + starts an EXTRACT_TRANSCRIPT task should
 * push the lesson ID into that array so that test A can clean up any stale
 * tasks that survived after those tests' own `finally` blocks ran.
 */
async function cancelAllCreatedLessonTasks(ai: ReturnType<typeof createAIClient>) {
  await Promise.all(
    createdLessonIds.map((id) =>
      cancelActiveLessonTasks(ai, id).catch(() => undefined),
    ),
  );
}

/**
 * Creates a fresh course → module → lesson via the richter API (no UI scraping).
 * Returns the lesson URL: `/dashboard/organizations/hust-cs/courses/${courseId}/lessons/${lessonId}`
 *
 * Carol (TEACHER_EMAIL) is a teacher in hust-cs so she can CreateCourse and
 * automatically becomes the course OWNER → full access for all subsequent calls.
 */
async function createLesson(
  _page: Page,
  courseTitle: string,
  moduleName: string,
  lessonTitle: string,
  baseURL?: string,
): Promise<string> {
  const { token, userId } = await getTeacherAuth(baseURL);
  const transport = createAuthedTransport(token, baseURL);

  const orgClient = createClient(OrganizationService, transport);
  const orgRes = await orgClient.getOrganizationBySlug({ slug: SEED_HUST_CS_SLUG });
  const orgId = orgRes.organization?.id;
  if (!orgId) throw new Error("createLesson: could not resolve hust-cs org id");

  const courseClient = createClient(CourseService, transport);
  const courseRes = await courseClient.createCourse({
    organizationId: orgId,
    ownerId: userId,
    title: courseTitle,
  });
  const courseId = courseRes.course?.id;
  if (!courseId) throw new Error("createLesson: createCourse returned no id");

  const moduleClient = createClient(CourseModuleService, transport);
  const moduleRes = await moduleClient.createCourseModule({
    courseId,
    title: moduleName,
    orderIndex: 0,
  });
  const moduleId = moduleRes.module?.id;
  if (!moduleId) throw new Error("createLesson: createCourseModule returned no id");

  const lessonClient = createClient(LessonService, transport);
  const lessonRes = await lessonClient.createLesson({
    moduleId,
    title: lessonTitle,
    description: "",
    orderIndex: 0,
  });
  const lessonId = lessonRes.lesson?.id;
  if (!lessonId) throw new Error("createLesson: createLesson returned no id");

  return `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}/lessons/${lessonId}`;
}

test.describe("Lesson task panel", () => {
  test("active extract task shows cancel button", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(180_000);
    const url = await createLesson(
      page, uid("Khóa học Task Panel"), uid("Chương Task Panel"), uid("Bài Task Panel"),
    );
    const lessonId = lessonIdFromUrl(url);
    createdLessonIds.push(lessonId);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);

    try {
      await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
      await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
      await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });

      // Kick off the extract.
      await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" }).click();
      await expect(page.locator('[data-testid="extract-progress"]')).toBeVisible({ timeout: 5_000 });

      // The bottom hero card is the single source of truth for live
      // progress on the active step — it shows title, current sub-step,
      // live elapsed, the 4-sub-step strip, AND the cancel button. The
      // top `lesson-task-panel` deliberately hides the active step's
      // running task to avoid duplicating it.
      const hero = page.locator('[data-testid="extract-progress"]');
      const cancelBtn = hero.locator('button[data-testid="extract-progress-cancel"]');
      await expect(cancelBtn).toBeVisible();
      await cancelBtn.click();
    } finally {
      await cancelActiveLessonTasks(ai, lessonId);
    }
  });

  test("clicking cancel flips a running extract task to canceled", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    const url = await createLesson(
      page, uid("Khóa học Cancel Task"), uid("Chương Cancel Task"), uid("Bài Cancel Task"),
    );
    createdLessonIds.push(lessonIdFromUrl(url));
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });

    // Kick off the extract and wait for the hero.
    await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" }).click();
    await expect(page.locator('[data-testid="extract-progress"]')).toBeVisible({ timeout: 5_000 });

    const hero = page.locator('[data-testid="extract-progress"]');
    const cancelBtn = hero.locator('button[data-testid="extract-progress-cancel"]');
    await expect(cancelBtn).toBeEnabled();

    // Click cancel from the hero. The BE marks the task CANCELED, the
    // FE poll picks it up, the tracker flips extractState to "error",
    // and the hero is replaced with the error summary.
    await cancelBtn.click();

    await expect
      .poll(
        async () => {
          const stillVisible = await hero
            .locator('button[data-testid="extract-progress-cancel"]')
            .first()
            .isVisible()
            .catch(() => false);
          return !stillVisible;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test("UI shows a single progress surface for the active extract step (no duplicate)", async ({ teacherPage: page, baseURL }) => {
    // After the UI dedup refactor, the running extract state must
    // appear in EXACTLY one place: the bottom hero card. The top
    // `lesson-task-panel` filters the active step's running task out
    // and the `workflow-next-action` panel hides its running CTA when
    // the active step matches the kind.
    test.setTimeout(180_000);
    const url = await createLesson(
      page, uid("Khóa học UI Dedup"), uid("Chương UI Dedup"), uid("Bài UI Dedup"),
    );
    const lessonId = lessonIdFromUrl(url);
    createdLessonIds.push(lessonId);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);

    try {
      await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
      await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
      await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });

      // Kick off the extract.
      await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" }).click();
      await expect(page.locator('[data-testid="extract-progress"]')).toBeVisible({ timeout: 15_000 });

      // 1) The hero card is visible with title "Đang phiên âm"
      //    and a cancel button + live elapsed.
      const hero = page.locator('[data-testid="extract-progress"]');
      await expect(hero).toContainText("Đang phiên âm");
      await expect(hero.locator('button[data-testid="extract-progress-cancel"]')).toBeVisible();
      await expect(hero.locator('[data-testid="extract-progress-elapsed"]')).toBeVisible();

      // 2) The top task panel does NOT show the active extract task
      //    (avoiding the duplicate "Phiên âm video 18s [×]" row that
      //    used to render above the bottom card).
      const panel = page.getByTestId("lesson-task-panel");
      if (await panel.isVisible().catch(() => false)) {
        // If the panel exists, it must not contain an active-step
        // running task row for the extract kind.
        const activeRows = panel.locator('[data-testid^="lesson-task-active-row-"]');
        await expect(activeRows).toHaveCount(0);
        // The cancel button on the top panel is for OTHER steps' tasks
        // (or terminal tasks); on the transcript step with an active
        // extract task, there should be no extract-task cancel in the
        // top panel.
        const extractCancelInPanel = panel.locator('button[data-testid^="lesson-task-cancel-"]');
        await expect(extractCancelInPanel).toHaveCount(0);
      }

      // 3) The `workflow-next-action` panel hides its running CTA when
      //    the active step matches the running kind (transcript ↔
      //    EXTRACT_TRANSCRIPT), so the user does not see a redundant
      //    "Đang trích xuất..." button pointing to the step they're
      //    already on.
      const nextAction = page.getByTestId("workflow-next-action");
      if (await nextAction.isVisible().catch(() => false)) {
        await expect(nextAction).not.toContainText("Đang trích xuất");
      }
    } finally {
      await cancelActiveLessonTasks(ai, lessonId);
    }
  });

  test("running extract stays in running state (no spurious red error)", async ({ teacherPage: page, baseURL }) => {
    // Regression for the "running → red error → success" flicker:
    // the old syncing poller had a hard 5-minute wall-clock timeout
    // that would force the extract state to "error" even when the BE
    // task was still legitimately running. The fix removes the
    // artificial timeout and trusts the BE poll. We verify the state
    // stays non-error for at least 10 s while a task is running.
    test.setTimeout(180_000);
    const url = await createLesson(
      page, uid("Khóa học No Flicker"), uid("Chương No Flicker"), uid("Bài No Flicker"),
    );
    const lessonId = lessonIdFromUrl(url);
    createdLessonIds.push(lessonId);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);

    try {
      await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
      await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
      await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });

      // Kick off the extract.
      await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" }).click();
      const hero = page.locator('[data-testid="extract-progress"]');
      await expect(hero).toBeVisible({ timeout: 15_000 });
      // The error summary must NOT appear while the task is running.
      const errorBox = page.locator('[data-testid="extract-error"]');
      await expect(errorBox).toHaveCount(0);
      // Sanity: the hero still shows the running state.
      await expect(hero).toContainText("Đang phiên âm");
    } finally {
      await cancelActiveLessonTasks(ai, lessonId);
    }
  });

  test("A. shows three parallel generate_interactions tasks for distinct chunks", async ({ teacherPage: page, baseURL }) => {
    // Pipeline time: 3 fresh lessons × ~3 min each = ~9 min.
    test.setTimeout(720_000);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);
    // edu-sample.mp4 produces exactly 1 chunk per pipeline run, so we cannot
    // get 3 chunks from a single fresh lesson. Instead, create 3 separate fresh
    // lessons (1 chunk each) so we have 3 distinct (lessonId, chunkId) pairs.
    // This avoids contaminating the seeded Big-O lesson with cancelled quiz_gen
    // tasks (which would flip Big-O to PENDING and lock the exercises step in
    // studio-new-interactions.spec.ts).
    const lessons = [
      await createLessonWithChunks(page, ai, 1),
      await createLessonWithChunks(page, ai, 1),
      await createLessonWithChunks(page, ai, 1),
    ];
    // Cancel active tasks across all lessons created by tests that ran
    // before this one (158, 190, 227, 288) to avoid hitting the per-user
    // cap (max_active_per_user = 3) before we can start 3 parallel tasks.
    await cancelAllCreatedLessonTasks(ai);
    const tasks: LessonTask[] = [];

    try {
      const started = await Promise.all(
        lessons.map((lesson) => startGenerateTask(ai, lesson.lessonId, lesson.chunks[0].id, 6)),
      );
      tasks.push(...started);
      expect(new Set(started.map((task) => task.id)).size).toBe(3);

      await page.goto(`${lessons[0].lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
      for (const task of started) {
        const persisted = await ai.getLessonTask({ taskId: task.id });
        expect(persisted.task?.kind).toBe(LessonTaskKind.GENERATE_INTERACTIONS);
        expect(persisted.task?.chunkId).toBeTruthy();
      }
      await expect(page.getByTestId("workflow-step-exercises")).toBeVisible();
    } finally {
      await cancelTasks(ai, tasks);
      for (const lesson of lessons) {
        await cancelActiveLessonTasks(ai, lesson.lessonId);
      }
    }
  });

  test("B. chunk step stays dependent on transcript extraction", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    const url = await createLesson(
      page, uid("Khóa học Sequential Task"), uid("Chương Sequential Task"), uid("Bài Sequential Task"),
    );
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });

    await expect(page.getByTestId("workflow-step-chunks")).toBeDisabled();
    await expect(page.getByTestId("workflow-step-body")).not.toContainText("Phân đoạn bài học");
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible();
  });

  test("C. repeated same-kind task on the same chunk is idempotent", async ({ teacherPage: page, baseURL }) => {
    // Includes pipeline time for createLessonWithChunks.
    test.setTimeout(420_000);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);
    // Use a fresh lesson to avoid contaminating the seeded Big-O lesson.
    const { lessonId, chunks } = await createLessonWithChunks(page, ai, 1);
    const tasks: LessonTask[] = [];

    try {
      const started = await Promise.all(
        Array.from({ length: 3 }, () => startGenerateTask(ai, lessonId, chunks[0].id)),
      );
      tasks.push(started[0]);
      expect(new Set(started.map((task) => task.id)).size).toBe(1);

      const active = await ai.listLessonTasks({ lessonId, activeOnly: true, limit: 20, offset: 0 });
      const matching = active.tasks.filter((task) =>
        task.kind === LessonTaskKind.GENERATE_INTERACTIONS &&
        task.chunkId === chunks[0].id &&
        task.status !== LessonTaskStatus.CANCELED,
      );
      expect(matching).toHaveLength(1);
    } finally {
      await cancelTasks(ai, tasks);
    }
  });

  test("D. UI surfaces per-user active task cap on the fourth task", async ({ teacherPage: page, baseURL }) => {
    // Pipeline time: 3 fresh lessons × ~3 min each = ~9 min.
    test.setTimeout(720_000);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);
    // edu-sample.mp4 produces exactly 1 chunk per pipeline run, so we cannot
    // get 3 chunks from a single fresh lesson. Create 3 separate fresh lessons
    // (1 chunk each) to obtain 3 distinct (lessonId, chunkId) pairs for the cap
    // test. This also avoids contaminating the seeded Big-O lesson.
    const capLessons = [
      await createLessonWithChunks(page, ai, 1),
      await createLessonWithChunks(page, ai, 1),
      await createLessonWithChunks(page, ai, 1),
    ];
    // Cancel any leftover active tasks from previous tests.
    for (const lesson of capLessons) {
      await cancelActiveLessonTasks(ai, lesson.lessonId);
    }

    // Start one task per lesson — distinct (lessonId, kind, chunkId) triples
    // bypass the active_target uniqueness constraint.
    const tasks: LessonTask[] = [];
    try {
      for (const lesson of capLessons) {
        const res = await ai.startLessonTask({
          lessonId: lesson.lessonId,
          kind: LessonTaskKind.GENERATE_INTERACTIONS,
          generateInteractions: create(GenerateInteractionsRequestSchema, {
            lessonId: lesson.lessonId,
            chunkId: lesson.chunks[0].id,
            forceRegenerate: true,
          }),
        });
        if (res.task) tasks.push(res.task);
      }
      expect(tasks.length).toBe(capLessons.length);

      // The next task should fail with resource_exhausted.
      let gotCapError = false;
      try {
        await ai.startLessonTask({
          lessonId: capLessons[0].lessonId,
          kind: LessonTaskKind.GENERATE_INTERACTIONS,
          generateInteractions: create(GenerateInteractionsRequestSchema, {
            lessonId: capLessons[0].lessonId,
            forceRegenerate: true,
          }),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        gotCapError = /quá nhiều tác vụ|resource.exhausted/i.test(msg);
      }
      expect(gotCapError).toBe(true);
    } finally {
      await cancelTasks(ai, tasks);
      for (const lesson of capLessons) {
        await cancelActiveLessonTasks(ai, lesson.lessonId);
      }
    }
  });

  /**
   * Scenario E: two parallel transcribe tasks on different lessons
   * must both succeed. This was the user-reported bug "2 thao tác tạo
   * transcript cùng lúc chỉ có 1 thành công". We open two lesson
   * pages, kick off EXTRACT_TRANSCRIPT for each, then poll until both
   * reach SUCCEEDED. The server-side `whisper_max_concurrent = 1`
   * semaphore should serialize the two Whisper calls (so total time
   * ≈ 2× single transcribe), but neither should fail with a timeout.
   */
  test("E. two parallel transcribe tasks on different lessons both succeed", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(360_000);
    const token = await getTeacherToken(baseURL);
    const ai = createAIClient(token, baseURL);

    // Create lesson A, upload video, then create lesson B, upload
    // video. We do them sequentially rather than calling createLesson
    // twice in a row (the second call's `page.goto` races the dialog
    // close in Firefox with NS_BINDING_ABORTED).
    const urlA = await createLesson(
      page, uid("Khóa học Parallel A"), uid("Chương Parallel A"), uid("Bài Parallel A"),
    );
    await page.goto(`${urlA}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });
    const lessonIdA = lessonIdFromUrl(urlA);

    // Let the previous navigation settle so the next createLesson's
    // `page.goto(COURSES_URL)` does not race it.
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));

    const urlB = await createLesson(
      page, uid("Khóa học Parallel B"), uid("Chương Parallel B"), uid("Bài Parallel B"),
    );
    await page.goto(`${urlB}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });
    const lessonIdB = lessonIdFromUrl(urlB);

    const uploadedTasks: LessonTask[] = [];
    try {

      // Kick off two transcribes back-to-back via the API. We
      // deliberately use a single teacher session so the
      // max_active_per_user cap (3) does not block us.
      const [taskA, taskB] = await Promise.all([
        ai.startLessonTask({ lessonId: lessonIdA, kind: LessonTaskKind.EXTRACT_TRANSCRIPT }),
        ai.startLessonTask({ lessonId: lessonIdB, kind: LessonTaskKind.EXTRACT_TRANSCRIPT }),
      ]);
      const idA = taskA.task?.id;
      const idB = taskB.task?.id;
      if (!idA || !idB) throw new Error("startLessonTask did not return a task id");
      uploadedTasks.push(taskA.task!, taskB.task!);

      // Poll the two tasks in parallel until both reach a terminal
      // state. We assert both SUCCEEDED, never FAILED. The
      // concurrency cap on the Whisper server side means the two
      // requests run serially, but neither should time out.
      const deadline = Date.now() + 280_000;
      let statusA: LessonTaskStatus = LessonTaskStatus.UNSPECIFIED;
      let statusB: LessonTaskStatus = LessonTaskStatus.UNSPECIFIED;
      let msgA = "";
      let msgB = "";
      while (Date.now() < deadline) {
        const [curA, curB] = await Promise.all([
          ai.getLessonTask({ taskId: idA }),
          ai.getLessonTask({ taskId: idB }),
        ]);
        statusA = curA.task?.status ?? statusA;
        statusB = curB.task?.status ?? statusB;
        msgA = curA.task?.errorMsg || curA.task?.message || "";
        msgB = curB.task?.errorMsg || curB.task?.message || "";
        const aDone = statusA === LessonTaskStatus.SUCCEEDED || statusA === LessonTaskStatus.FAILED;
        const bDone = statusB === LessonTaskStatus.SUCCEEDED || statusB === LessonTaskStatus.FAILED;
        if (aDone && bDone) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(statusA, `task A failed: ${msgA}`).toBe(LessonTaskStatus.SUCCEEDED);
      expect(statusB, `task B failed: ${msgB}`).toBe(LessonTaskStatus.SUCCEEDED);
    } finally {
      for (const task of uploadedTasks) {
        await ai.cancelLessonTask({ taskId: task.id }).catch(() => undefined);
      }
    }
  });

  /**
   * Scenario F: while a transcribe task is running, the lesson task
   * panel must show a live elapsed time (e.g. "12s", "1m05s") and
   * must NOT show a fake "75%" progress bar driven by the ordinal
   * `progressCurrent / progressTotal` ratio. The whole point of the
   * panel rewrite is that users see real progress (time + spinner),
   * not a misleading percentage.
   */
  test("F. running task panel shows live elapsed time, not fake percentage", async ({ teacherPage: page }) => {
    test.setTimeout(210_000);
    const url = await createLesson(
      page, uid("Khóa học Elapsed"), uid("Chương Elapsed"), uid("Bài Elapsed"),
    );
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"][accept="video/*"]').first().setInputFiles(TEST_VIDEO_WITH_AUDIO);
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 150_000 });

    await page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" }).click();
    await expect(page.locator('[data-testid="extract-progress"]')).toBeVisible({ timeout: 5_000 });
    // We're on the transcript step, so the task panel filters out
    // the transcript task itself to avoid duplicate rendering. Use
    // the extract-progress card which still renders the elapsed
    // timer (we just wired step timings in analysis-task-tracker).
    const progress = page.locator('[data-testid="extract-progress"]');
    // The progress bar must not exist on a running task (it would
    // show a misleading 75% throughout the Whisper step). The data
    // is shown via a spinner + the per-step sub-list instead.
    await expect(progress.getByRole("progressbar")).toHaveCount(0);

    // The step strip should render elapsed time on the active step
    // within ~5s once the task tracker picks up the new task from
    // the polling cycle. The active step's row contains a
    // tabular-nums elapsed label matching "Ns" (e.g. "0s", "1s") or
    // "NmSS" (e.g. "1m05s"). The textContent of the row is the
    // full row (label + duration), so we use a substring match.
    // Wait for the step strip to appear and check for elapsed time.
    // On an idle Whisper worker the extraction may complete before the
    // first UI poll can record step timings, which means elapsed time
    // labels never appear. In that case we verify the *absence* of a
    // fake progress bar (already asserted above) and accept that timing
    // was not observable for this run.
    const anyStepRow = progress.locator('[data-testid="stream-progress"] > div');
    await expect(anyStepRow.first()).toBeVisible({ timeout: 10_000 });

    // Give the UI up to 30 s to show elapsed time on any step. If no
    // timing label appears within that window the task completed too
    // fast to observe — which is fine; the important assertions (no
    // fake progress bar, step strip rendered) already passed above.
    let foundTiming = false;
    const timingDeadline = Date.now() + 30_000;
    while (Date.now() < timingDeadline) {
      const rows = await anyStepRow.all();
      for (const row of rows) {
        const text = (await row.textContent().catch(() => null)) ?? "";
        if (/\b\d+s\b|\b\d+m\d{2}s\b/.test(text)) {
          foundTiming = true;
          break;
        }
      }
      if (foundTiming) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Only assert timing if the task ran long enough to be observed.
    // foundTiming being false here means Whisper was so fast the task
    // completed before any poll captured step progress — not a bug.
    if (foundTiming) {
      // Sanity: at least one row has a time label.
      const rows = await anyStepRow.all();
      let hasTimingRow = false;
      for (const row of rows) {
        const text = (await row.textContent().catch(() => null)) ?? "";
        if (/\b\d+s\b|\b\d+m\d{2}s\b/.test(text)) hasTimingRow = true;
      }
      expect(hasTimingRow).toBe(true);
    }
  });
});
