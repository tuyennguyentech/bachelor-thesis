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
import {
  test,
  expect,
  loginAs,
  TEACHER_EMAIL,
  USER_PASSWORD,
  getTeacherAuth,
  getAdminAuth,
  getToken,
  createUser,
  getOrgId,
  addOrgMember,
  createAuthedTransport,
  createCourse,
  createCourseModule,
  SEED_HUST_CS_SLUG,
  UserRole,
  OrganizationRole,
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

/**
 * Like setupIsolatedCourse, but the course is owned by a FRESH teacher and the
 * test's browser session must log in as them (returned `teacherEmail`).
 *
 * startLessonTask enforces a per-user active-task cap (MaxActivePerUser = 3,
 * "bạn đã chạy quá nhiều tác vụ cùng lúc"). Quick-create submits the pipeline
 * from the BROWSER session, and pipelines keep running server-side after their
 * test ends — so tests sharing carol also share her cap with every still-running
 * pipeline, and the LAST submit test in this file flaked on resource_exhausted.
 * A fresh teacher per submit test gives each its own quota — the same pattern
 * createAnalyzedLesson uses for its API-driven pipelines.
 */
async function setupIsolatedCourseAsFreshTeacher(
  baseURL: string | undefined,
): Promise<{ courseUrl: string; courseId: string; moduleId: string; token: string; userId: string; teacherEmail: string }> {
  const { token: adminToken } = await getAdminAuth(baseURL);
  const teacherEmail = `${uid("qc-teacher")}@test.local`;
  const userId = await createUser(
    adminToken,
    { email: teacherEmail, firstName: "QC", lastName: "Teacher", role: UserRole.NORMAL },
    baseURL,
  );
  const orgId = await getOrgId(adminToken, SEED_HUST_CS_SLUG, baseURL);
  await addOrgMember(adminToken, orgId, userId, OrganizationRole.TEACHER, baseURL);
  const token = await getToken(teacherEmail, USER_PASSWORD, baseURL);

  const courseId = await createCourse(token, orgId, uid("QC-Course"), userId, baseURL);
  const moduleId = await createCourseModule(token, courseId, uid("QC-Module"), baseURL);
  const courseUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}?tab=lessons`;
  return { courseUrl, courseId, moduleId, token, userId, teacherEmail };
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
    // Fresh teacher: this test starts a durable pipeline (counts against the
    // per-user task cap), so it must not share carol's quota.
    const { courseUrl, teacherEmail } = await setupIsolatedCourseAsFreshTeacher(baseURL);
    await loginAs(page, teacherEmail, USER_PASSWORD, baseURL ?? "http://caddy");
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

  // Two entry points: quick-create (auto) and manual processing. "Xử lý thủ công"
  // is now a client-side tab-switch button (was a <Link>), see BUG-F.
  await expect(page.getByTestId("quick-create-lesson-trigger")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("manual-processing-cta")).toBeVisible();

  // The quick-create button opens the dialog scoped to this existing lesson.
  await page.getByTestId("quick-create-lesson-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/Tạo nhanh:/)).toBeVisible();
});

// ── Test: EXISTING-lesson quick-create updates the video tab + stepper IN-PLACE ──
// Regression for the "frozen after Tạo nhanh" bug: for an existing (video-less)
// lesson, quick-create pushed ?tab=processing on the SAME pathname WITHOUT a
// router.refresh(), so the App Router served stale SSR (videoStorageKey empty) —
// the content tab stayed on "Chưa có video" and the stepper's step 1 stayed "Chờ
// tải video" until a manual reload. The fix adds router.refresh() in goToProcessing.
test.slow();
test("QuickCreate: existing-lesson quick-create hands off with a fresh SSR read (video + stepper, no manual reload)", async ({ teacherPage: page, baseURL }) => {
  // Fresh teacher: submits a pipeline — must not share carol's per-user task cap.
  const { courseId, moduleId, token, teacherEmail } = await setupIsolatedCourseAsFreshTeacher(baseURL);
  await loginAs(page, teacherEmail, USER_PASSWORD, baseURL ?? "http://caddy");

  const lessonClient = createClient(LessonService, createAuthedTransport(token, baseURL));
  const created = await lessonClient.createLesson({ moduleId, title: uid("QC-InPlace"), orderIndex: 0 });
  const lessonId = created.lesson!.id;
  const lessonUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}/lessons/${lessonId}`;

  await page.goto(lessonUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Chưa có video/)).toBeVisible({ timeout: 10_000 });

  // Tag the current document. The freeze's root cause is that the hand-off used a
  // SOFT same-segment `?tab=` router.push (kept this document), which the App Router
  // can serve from the stale client cache WITHOUT re-running the Server Component →
  // stale videoStorageKey/activeTab (content stuck on "Chưa có video", stepper stuck
  // at step 1, poller disabled). The fix hard-navigates so SSR always re-runs. This
  // marker deterministically distinguishes the two: it SURVIVES a soft push (freeze,
  // pre-fix) and is GONE after a full navigation (fixed) — independent of the flaky
  // warm-cache timing that headless Playwright can't reproduce via symptoms alone.
  await page.evaluate(() => { (window as unknown as { __preQc?: boolean }).__preQc = true; });

  // Run quick-create scoped to THIS existing lesson.
  await page.getByTestId("quick-create-lesson-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);
  await expect(page.getByText(/edu-sample-en\.mp4/)).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();
  await page.getByRole("button", { name: /Tạo.*chạy ngay/i }).click();

  // Hands off to the processing tab.
  await expect(page).toHaveURL(/\/lessons\/.*tab=processing/, { timeout: 120_000 });

  // ROOT-CAUSE assertion (FAILS pre-fix): the hand-off must be a full-document
  // navigation (fresh SSR). Pre-fix soft push keeps the document → marker survives.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __preQc?: boolean }).__preQc ?? false), { timeout: 15_000 })
    .toBe(false);

  // Symptom fixed WITHOUT any test-side reload: auto-landed on the processing tab
  // (SSR activeTab=processing), the video surfaced, and the pipeline is live.
  await expect(page.getByTestId("lesson-tab-processing")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await expect(page.getByTestId("workflow-step-upload")).toContainText(/Đã tải lên/, { timeout: 30_000 });
  await expect(page.getByTestId("pipeline-auto-banner")).toBeVisible({ timeout: 30_000 });

  // The content tab's VideoPlayer shows the video — no longer the empty "Chưa có video".
  await page.getByTestId("lesson-tab-content").click();
  await expect(page.getByTestId("video-player")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Chưa có video/)).toHaveCount(0);
});

// ── Test: after quick-create transcribes, the transcript shows on the step + video ──
// tab, and the count is labelled "dòng" (transcript lines) — NOT "đoạn", which step 3
// "Phân đoạn" uses for CHUNKS (the reported "N đoạn là cái gì" confusion). Runs the
// real transcription (audio=en so it succeeds); chunk/gen use the test Gemini engine.
test.slow();
test("QuickCreate: transcript surfaces on the step + video tab after transcribing, labelled 'dòng' (not 'đoạn')", async ({ teacherPage: page, baseURL }) => {
  test.setTimeout(360_000);
  // Fresh teacher: submits a pipeline — must not share carol's per-user task cap.
  // This test flaked exactly here: as the LAST submit test in the file it found
  // carol's cap already filled by the earlier tests' still-running pipelines
  // ("[resource_exhausted] bạn đã chạy quá nhiều tác vụ cùng lúc, giới hạn là 3"),
  // so quick-create showed its error state and never navigated.
  const { courseId, moduleId, token, teacherEmail } = await setupIsolatedCourseAsFreshTeacher(baseURL);
  await loginAs(page, teacherEmail, USER_PASSWORD, baseURL ?? "http://caddy");
  const lessonClient = createClient(LessonService, createAuthedTransport(token, baseURL));
  const lessonId = (await lessonClient.createLesson({ moduleId, title: uid("QC-Transcript"), orderIndex: 0 })).lesson!.id;

  await page.goto(`/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses/${courseId}/lessons/${lessonId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Chưa có video/)).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("quick-create-lesson-trigger").click();
  await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);
  await expect(page.getByText(/edu-sample-en\.mp4/)).toBeVisible({ timeout: 5_000 });
  // Audio language = English (Radix Select) so Whisper transcribes edu-sample-en cleanly.
  await page.getByTestId("qc-audio-language").click();
  await page.getByRole("option", { name: /English/ }).click();
  await page.getByRole("button", { name: "Tăng Trắc nghiệm 1 đáp án" }).click();
  await page.getByRole("button", { name: /Tạo.*chạy ngay/i }).click();
  await expect(page).toHaveURL(/\/lessons\/.*tab=processing/, { timeout: 120_000 });

  // ISSUE 2: once transcription finishes, the transcript step reports its line count
  // as "N dòng" (not "N đoạn"), so it no longer reads like the chunk step's count.
  await expect(page.getByTestId("workflow-step-transcript")).toContainText(/\d+\s*dòng/, { timeout: 240_000 });
  await expect(page.getByTestId("workflow-step-transcript")).not.toContainText(/\d+\s*đoạn/);

  // ISSUE 1: the transcript actually renders — rows in the step, and the interactive
  // transcript on the video tab — after quick-create (no manual reload).
  await page.getByTestId("workflow-step-transcript").click();
  await expect(page.locator('[data-testid^="edit-transcript-segment-"]').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("lesson-tab-content").click();
  await expect(page.getByTestId("interactive-transcript")).toBeVisible({ timeout: 20_000 });
});
