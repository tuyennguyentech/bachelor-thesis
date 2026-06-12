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
  authedClient,
  createAuthedTransport,
  createCourse,
  createCourseModule,
  rpcBaseUrl,
  SEED_HUST_CS_SLUG,
} from "../fixtures";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";

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
});

// ── Test: submit disabled until title + video ─────────────────────────────────

test("QuickCreate: submit button disabled until title and video selected", async ({ teacherPage: page, baseURL }) => {
  const { courseUrl } = await setupIsolatedCourse(baseURL);
  await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
  await page.goto(courseUrl, { waitUntil: "domcontentloaded" });

  await page.getByTestId("quick-create-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const submitBtn = page.getByRole("button", { name: /Tạo.*Phân tích/i });
  await expect(submitBtn).toBeDisabled();

  // Fill title — still disabled (no video)
  await page.getByLabel(/Tiêu đề bài học/).fill(uid("QC-Lesson-Submit-Test"));
  await expect(submitBtn).toBeDisabled();

  // Pick video — should enable
  await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);
  await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
});

// ── Test: full pipeline (slow) ────────────────────────────────────────────────

test.slow();
test(
  "QuickCreate: full pipeline runs to done and navigates to lesson",
  async ({ teacherPage: page, baseURL }) => {
    const lessonTitle = uid("QC-Pipeline-Test");
    const { courseUrl, token } = await setupIsolatedCourse(baseURL);
    await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
    await page.goto(courseUrl, { waitUntil: "domcontentloaded" });

    await page.getByTestId("quick-create-trigger").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel(/Tiêu đề bài học/).fill(lessonTitle);
    await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);

    // Wait for video to be selected
    await expect(page.getByText(/edu-sample-en\.mp4/)).toBeVisible({ timeout: 5_000 });

    // Submit
    await page.getByRole("button", { name: /Tạo.*Phân tích/i }).click();

    // The uploading phase may be very brief for small test videos (66 KB uploads near-instantly).
    // Wait for either the upload phase or the running phase (whichever is first visible).
    await expect(
      page.getByText(/Đang tải video lên|Đang xử lý bài học/),
    ).toBeVisible({ timeout: 60_000 });

    // Wait for running phase (pipeline starts) — this may already be visible from above
    await expect(page.getByText(/Đang xử lý bài học/)).toBeVisible({ timeout: 90_000 });

    // Poll until the dialog shows done or error (3-stage strip visible)
    await expect(page.getByText(/Phiên âm/)).toBeVisible({ timeout: 30_000 });

    // Wait for completion (done phase)
    await expect(page.getByText(/Hoàn thành!/)).toBeVisible({ timeout: 300_000 });

    // Navigate to lesson
    await page.getByRole("button", { name: /Vào bài học/ }).click();

    // Should navigate to the lesson page
    await expect(page).toHaveURL(/\/lessons\//, { timeout: 15_000 });
    await expect(page.getByText(lessonTitle).first()).toBeVisible({ timeout: 10_000 });
  },
);

// ── Test: cancel mid-pipeline ─────────────────────────────────────────────────

test("QuickCreate: cancel button stops pipeline and closes dialog", async ({ teacherPage: page, baseURL }) => {
  const lessonTitle = uid("QC-Cancel-Test");
  const { courseUrl, token } = await setupIsolatedCourse(baseURL);
  await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
  await page.goto(courseUrl, { waitUntil: "domcontentloaded" });

  await page.getByTestId("quick-create-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByLabel(/Tiêu đề bài học/).fill(lessonTitle);
  await page.getByTestId("qc-video-input").setInputFiles(TEST_VIDEO);
  await expect(page.getByText(/edu-sample-en\.mp4/)).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: /Tạo.*Phân tích/i }).click();

  // Wait until we're in the running phase (pipeline started)
  await expect(page.getByText(/Đang xử lý bài học/)).toBeVisible({ timeout: 90_000 });

  // Click cancel
  await page.getByRole("button", { name: /Hủy tác vụ/ }).click();

  // Dialog should close
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10_000 });
});
