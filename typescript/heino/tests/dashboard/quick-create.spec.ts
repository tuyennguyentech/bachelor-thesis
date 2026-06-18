/**
 * E2E tests for the "Tạo nhanh bài học" (Quick Create) feature.
 *
 * Prerequisites:
 *   - richter seed --dev has been run (org hust-cs, teacher carol@dyadia.local)
 *   - Piper TTS and Whisper services are reachable (for the full pipeline test)
 *
 * Design constraints:
 *   - Self-isolating: each test creates its own course+module (unique UUID title)
 *     via the RPC API and navigates to the lessons tab.
 *   - No shared state mutations — no attempt to reuse seeded lessons.
 */

import path from "path";
import { createClient } from "@connectrpc/connect";
import { AIService, LessonTaskKind, LessonTaskStatus } from "buf/gen/richter/v1/ai_pb";
import {
  test,
  expect,
  loginAs,
  TEACHER_EMAIL,
  USER_PASSWORD,
  getTeacherAuth,
  createAuthedTransport,
  createCourse,
  createCourseModule,
  rpcBaseUrl,
  SEED_HUST_CS_SLUG,
} from "../fixtures";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { LessonService } from "buf/gen/richter/v1/courses_pb";

const TEST_VIDEO = path.join(__dirname, "../fixtures/edu-sample-en.mp4");

function uid(base: string) {
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Creates an isolated course + module via API and navigates to the lessons tab.
 * Returns the course URL + the course/module IDs.
 */
async function setupIsolatedCourse(
  baseURL: string | undefined,
): Promise<{ courseUrl: string; courseId: string; moduleId: string; token: string; userId: string }> {
  const { token, userId } = await getTeacherAuth(baseURL);
  // getOrganizationBySlug requires authentication
  const orgClient = createClient(OrganizationService, createAuthedTransport(token, baseURL));
  const orgRes = await orgClient.getOrganizationBySlug({ slug: SEED_HUST_CS_SLUG });
  const orgId = orgRes.organization?.id;
  if (!orgId) throw new Error("setupIsolatedCourse: could not resolve hust-cs org id");

  const courseId = await createCourse(token, orgId, uid("QC-Course"), userId, baseURL);
  const moduleId = await createCourseModule(token, courseId, uid("QC-Module"), baseURL);
  const courseUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}?tab=lessons`;
  return { courseUrl, courseId, moduleId, token, userId };
}

// ── Test: dialog opens + form fields visible ─────────────────────────────────

test("QuickCreate: dialog opens and shows required fields", async ({ teacherPage: page, baseURL }) => {
  const { courseUrl } = await setupIsolatedCourse(baseURL);
  await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
  await page.goto(courseUrl, { waitUntil: "domcontentloaded" });

  // Trigger button should be present
  const triggerBtn = page.getByTestId("quick-create-trigger");
  await expect(triggerBtn).toBeVisible({ timeout: 10_000 });
  await triggerBtn.click();

  // Dialog should open with key fields
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel(/Tiêu đề bài học/)).toBeVisible();
  // The video label is not linked via htmlFor (file input is hidden + accessed via data-testid),
  // so we check the label text directly instead of using getByLabel.
  await expect(page.getByText(/Video bài giảng/)).toBeVisible();
  // Config parity with the real "tạo bài tập" step: language, per-kind quantities,
  // attempts, and feedback mode are all configurable here.
  await expect(page.getByTestId("qc-language")).toBeVisible();
  // Quick-create must also expose the spoken-audio language (parity with manual
  // config) — otherwise an English video transcribes as Vietnamese.
  await expect(page.getByTestId("qc-audio-language")).toBeVisible();
  await expect(page.getByText("Số lượng theo loại")).toBeVisible();
  await expect(page.getByText(/Số lần làm/)).toBeVisible();
  await expect(page.getByText("Hiện kết quả")).toBeVisible();
});

// ── Test: submit disabled until title + video ─────────────────────────────────

test("QuickCreate: submit button disabled until title and video selected", async ({ teacherPage: page, baseURL }) => {
  const { courseUrl } = await setupIsolatedCourse(baseURL);
  await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
  await page.goto(courseUrl, { waitUntil: "domcontentloaded" });

  await page.getByTestId("quick-create-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const submitBtn = page.getByRole("button", { name: /Tạo.*chạy ngay/i });
  await expect(submitBtn).toBeDisabled();

  // Fill title — still disabled (no video)
  await page.getByLabel(/Tiêu đề bài học/).fill(uid("QC-Lesson-Submit-Test"));
  await expect(submitBtn).toBeDisabled();

  // Pick video — STILL disabled: Quick Create now opens with every kind at 0
  // (the manager consciously chooses how many questions per kind), so the total
  // quantity is 0 and there is nothing to generate yet.
  await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);
  await expect(submitBtn).toBeDisabled();

  // Add one question of a kind → now enabled.
  await page.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();
  await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
});

// ── Test: trigger is discoverable on the default (overview) tab ───────────────

test("QuickCreate: trigger is visible on the course overview (default) tab", async ({ teacherPage: page, baseURL }) => {
  const { courseId } = await setupIsolatedCourse(baseURL);
  await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
  // Land on the course's DEFAULT tab (Tổng quan / overview) — no ?tab= — which is
  // where a manager arrives first. The quick-create flow must be discoverable here
  // (the course has a module, so the lesson can be attached).
  await page.goto(`/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("quick-create-trigger")).toBeVisible({ timeout: 10_000 });
});

// ── Test: submit hands off to the processing tab (no blocking modal) ──────────

test.slow();
test(
  "QuickCreate: submit uploads then navigates to the processing tab with auto-progress",
  async ({ teacherPage: page, baseURL }) => {
    const lessonTitle = uid("QC-Pipeline-Test");
    const { courseUrl } = await setupIsolatedCourse(baseURL);
    await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
    await page.goto(courseUrl, { waitUntil: "domcontentloaded" });

    await page.getByTestId("quick-create-trigger").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel(/Tiêu đề bài học/).fill(lessonTitle);
    await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);
    await expect(page.getByText(/edu-sample-en\.mp4/)).toBeVisible({ timeout: 5_000 });

    // Quick Create opens with all kinds at 0; pick at least one so the pipeline
    // has something to generate (submit stays disabled while the total is 0).
    await page.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();

    await page.getByRole("button", { name: /Tạo.*chạy ngay/i }).click();

    // After upload, the dialog hands off to the lesson's processing tab — no
    // blocking modal. The durable RUN_PIPELINE task is already running there.
    await expect(page).toHaveURL(/\/lessons\/.*tab=processing/, { timeout: 120_000 });
    // The slim auto-pipeline banner proves the pipeline auto-runs server-side
    // (the user does not click each step). The 5-step stepper below it is the
    // single progress visualization, driven by the live progress_step.
    await expect(page.getByTestId("pipeline-auto-banner")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Đang xử lý tự động/)).toBeVisible();
  },
);

// ── Test: video tab of a video-less lesson offers quick-create + manual ───────

test("QuickCreate: video-less lesson shows quick-create + manual buttons", async ({ teacherPage: page, baseURL }) => {
  const { courseId, moduleId, token } = await setupIsolatedCourse(baseURL);
  await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");

  // Create a lesson with NO video via the API, then open its content tab.
  const lessonClient = createClient(LessonService, createAuthedTransport(token, baseURL));
  const created = await lessonClient.createLesson({ moduleId, title: uid("QC-NoVideo"), orderIndex: 0 });
  const lessonId = created.lesson!.id;

  await page.goto(
    `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}/lessons/${lessonId}`,
    { waitUntil: "domcontentloaded" },
  );

  // Two entry points: quick-create (auto) and manual processing.
  await expect(page.getByTestId("quick-create-lesson-trigger")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: /Xử lý thủ công/ })).toBeVisible();

  // The quick-create button opens the dialog scoped to this existing lesson.
  await page.getByTestId("quick-create-lesson-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/Tạo nhanh:/)).toBeVisible();
});
