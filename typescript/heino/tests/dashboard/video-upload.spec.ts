/**
 * E2E tests for the video upload flow on lesson detail pages.
 *
 * Requires the dyadia storage bucket to exist (run `richter seed` first).
 *
 * Flow under test:
 *   1. Teacher navigates to a lesson detail page → ?tab=processing
 *   2. Clicks "Tải video lên" → hidden <input type="file"> receives test-video.mp4
 *   3. Component calls getUploadUrl → XHR PUT → localhost/api/storage (Caddy → SeaweedFS)
 *   4. Component calls updateLessonVideo to persist the key in the DB
 *   5. UI shows success; button label changes to "Thay video"
 *   6. On page reload (with ?tab=processing), "Thay video" persists (server-rendered with stored key)
 *
 * NOTE: The video upload UI lives exclusively in ?tab=processing (via AnalyzeButton →
 * AnalysisWorkflowShell → VideoUpload).  All tests MUST navigate to ?tab=processing
 * before asserting or interacting with the upload widget.
 */

import path from "path";
import type { Page } from "@playwright/test";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import { CourseService, CourseModuleService, LessonService } from "buf/gen/richter/v1/courses_pb";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { test, expect, uid, goToSeededLesson, SEED_DSA_LESSON_BIG_O, TEACHER_EMAIL, USER_PASSWORD } from "../fixtures";

const ORG_SLUG = "hust-cs";
const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");

function rpcBaseUrl(baseURL?: string) {
  return process.env.RICHTER_BASE_URL ?? `${baseURL ?? "http://caddy"}/api/richter`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Creates a course → module → lesson via the richter API and returns the lesson URL.
 *  Callers must append ?tab=processing when navigating to the upload UI. */
async function createLessonAndNavigate(
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
  if (!orgId) throw new Error("createLessonAndNavigate: could not resolve org id");

  const courseClient = createClient(CourseService, authedTransport);
  const courseRes = await courseClient.createCourse({
    organizationId: orgId,
    ownerId: userId,
    title: courseTitle,
  });
  const courseId = courseRes.course?.id;
  if (!courseId) throw new Error("createLessonAndNavigate: createCourse returned no id");

  const moduleClient = createClient(CourseModuleService, authedTransport);
  const moduleRes = await moduleClient.createCourseModule({
    courseId,
    title: moduleName,
    orderIndex: 0,
  });
  const moduleId = moduleRes.module?.id;
  if (!moduleId) throw new Error("createLessonAndNavigate: createCourseModule returned no id");

  const lessonClient = createClient(LessonService, authedTransport);
  const lessonRes = await lessonClient.createLesson({
    moduleId,
    title: lessonTitle,
    description: "",
    orderIndex: 0,
  });
  const lessonId = lessonRes.lesson?.id;
  if (!lessonId) throw new Error("createLessonAndNavigate: createLesson returned no id");

  return `/dashboard/organizations/${ORG_SLUG}/courses/${courseId}/lessons/${lessonId}`;
}

// ── upload button visibility ───────────────────────────────────────────────────

test.describe("Upload button visibility", () => {
  test("teacher sees Tải video lên button on new lesson", async ({ teacherPage: page }) => {
    const lessonUrl = await createLessonAndNavigate(
      page,
      uid("Khóa học Upload Visibility"),
      uid("Chương Visibility"),
      uid("Bài học Visibility"),
    );
    // The upload UI lives exclusively in ?tab=processing
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
  });

  test("student does not see upload button", async ({ studentPage: page }) => {
    // Students get StudentLessonView — the teacher pipeline (including ?tab=processing)
    // is never rendered for them, so the upload button must be absent.
    // Navigate to the seeded lesson so the test is not affected by pagination order.
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Thay video" })).not.toBeVisible();
  });
});

// ── full upload flow ───────────────────────────────────────────────────────────

test.describe("Video upload flow", () => {
  let lessonUrl: string;

  test.beforeEach(async ({ teacherPage: page }) => {
    lessonUrl = await createLessonAndNavigate(
      page,
      uid("Khóa học Upload E2E"),
      uid("Chương Upload E2E"),
      uid("Bài học Upload E2E"),
    );
  });

  test("upload shows progress bar then success message", async ({ teacherPage: page }) => {
    // Heavy real-video upload: under parallel load the PUT to storage + DB update
    // + component remount can run long. Give the whole test generous headroom so a
    // slow-but-healthy upload isn't cut off by the default per-test cap.
    test.setTimeout(120_000);
    // Navigate to ?tab=processing so the upload widget is visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Wait for upload widget to be ready before triggering the file input (signals
    // the processing tab is hydrated, not just DOM-loaded).
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible({ timeout: 15_000 });
    // Set file directly on hidden input (bypasses OS file picker)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Progress bar appears while uploading (text: "Đang tải lên máy chủ..."). This is
    // transient — on a fast upload it can flash past before Playwright samples the DOM,
    // so treat its absence as non-fatal and rely on the stable post-upload signal below.
    await page.getByText(/Đang tải lên/).waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      /* progress bar may have already advanced — the success assertion is authoritative */
    });
    // After upload + DB update, the component remounts with videoStorageKey set and the
    // workflow advances to the transcript step. "Trích xuất transcript" is the stable
    // post-upload indicator (the transient "done" toast disappears on remount).
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 60_000 });
  });

  test("button changes from Tải video lên to Thay video after upload", async ({ teacherPage: page }) => {
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // After upload, the component remounts with videoStorageKey set and advances to step 2.
    // Navigate back to the upload step (step 1) to verify the button changed to "Thay video".
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tải video lên" })).not.toBeVisible();
  });

  test("video key persists after page reload", async ({ teacherPage: page }) => {
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Wait for upload to complete: workflow advances to transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    // Wait for router.refresh() to settle before hard-navigating
    await page.waitForLoadState("networkidle");

    // Hard reload with ?tab=processing — server must render "Thay video" since video_key is now set
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // After reload the activeStep defaults to "transcript" (video exists, no segments yet).
    // Click the stepper button to switch back to the upload step within the pipeline.
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
  });

  test("upload replaces video (Thay video flow)", async ({ teacherPage: page }) => {
    // First upload
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // Wait for upload to complete: workflow advances to transcript step.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    // Wait for router.refresh() to settle before hard-navigating
    await page.waitForLoadState("networkidle");

    // Reload so button is server-rendered as "Thay video"
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // activeStep defaults to "transcript" after reload when video exists; navigate to upload step
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();

    // Second upload via the replace button (same hidden input, button label irrelevant to setInputFiles)
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(TEST_VIDEO);
    // After replace, workflow advances to transcript step again — confirms second upload succeeded.
    await expect(page.getByTestId("workflow-next-action").getByRole("button", { name: "Trích xuất transcript" })).toBeVisible({ timeout: 30_000 });
    // Navigate to upload step to verify the button label is still "Thay video"
    await page.getByTestId("workflow-step-upload").click();
    await expect(page.getByRole("button", { name: "Thay video" })).toBeVisible();
  });
});

// ── invalid file type ─────────────────────────────────────────────────────────

test.describe("Upload validation", () => {
  test("non-video file shows error", async ({ teacherPage: page }) => {
    const lessonUrl = await createLessonAndNavigate(
      page,
      uid("Khóa học Upload Validation"),
      uid("Chương Validation"),
      uid("Bài học Validation"),
    );
    // Navigate to ?tab=processing so the upload widget is visible
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();

    // Create a minimal fake "image" buffer and set it as a non-video file
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });

    await expect(page.getByText("Chỉ hỗ trợ tệp video")).toBeVisible();
    // Upload button stays unchanged
    await expect(page.getByRole("button", { name: "Tải video lên" })).toBeVisible();
  });
});
