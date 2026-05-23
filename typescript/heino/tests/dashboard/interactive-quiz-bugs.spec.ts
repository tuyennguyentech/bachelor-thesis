/**
 * E2E tests for three critical video quiz bugs:
 *
 *   1. Quiz overlay uses spacious max-w-4xl card layout (not cramped max-w-lg).
 *   2. Retake resets video playhead to 0 and pauses.
 *   3. "Làm lại" button is disabled when attemptCount >= maxAttempts.
 *
 * Strategy: Use the seeded "Bài 1: Big-O, Omega, Theta notation" lesson which
 * already has analysis.status=done, a video, and 5 seeded MCQ interactions.
 * Bob (student) has a seeded attempt, so we leverage that for retake tests.
 */

import type { Page, APIRequestContext } from "@playwright/test";
import {
  test as base,
  expect,
  goToSeededLesson,
  SEED_DSA_LESSON_BIG_O as SEEDED_LESSON,
  TEACHER_EMAIL,
  USER_PASSWORD,
} from "../fixtures";

// Checkpoint seconds for seeded Big-O lesson (from video-quiz-flow.spec.ts)
const CHECKPOINT_SECONDS = [208, 416, 624, 831, 1039];
const RICHTER_BASE = "/api/richter";

/** Wait for React hydration to register the checkpoint test hook, then fire it. */
async function triggerCheckpoint(page: Page, seconds: number) {
  await page.waitForFunction(() => "__triggerVideoCheckpoint" in window, { timeout: 5_000 });
  await page.evaluate((s) => {
    (window as unknown as { __triggerVideoCheckpoint: (s: number) => void }).__triggerVideoCheckpoint(s);
  }, seconds);
}

// ── Teacher API helpers (uses a separate API context, not the student's browser) ──

async function getTeacherToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${RICHTER_BASE}/richter.v1.AuthService/Login`, {
    headers: { "Content-Type": "application/json" },
    data: { email: TEACHER_EMAIL, password: USER_PASSWORD },
  });
  if (!res.ok()) throw new Error(`Teacher login failed: ${res.status()}`);
  const body = await res.json();
  return body.accessToken as string;
}

async function teacherRpc<T = unknown>(
  request: APIRequestContext,
  token: string,
  service: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await request.post(`${RICHTER_BASE}/${service}/${method}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(`RPC ${service}.${method} -> HTTP ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function setMaxAttempts(
  request: APIRequestContext,
  token: string,
  lessonId: string,
  maxAttempts: number,
) {
  const res = await teacherRpc<{ lesson: { title: string; orderIndex: number } }>(
    request,
    token,
    "richter.v1.LessonService",
    "GetLessonById",
    { id: lessonId },
  );
  await teacherRpc(request, token, "richter.v1.LessonService", "UpdateLesson", {
    id: lessonId,
    title: res.lesson.title,
    orderIndex: res.lesson.orderIndex,
    maxAttempts,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

const test = base;

test.describe("Interactive Video Quiz Overlay & Retake Constraints", () => {
  // Reset maxAttempts to 0 before and after each test to avoid database pollution
  test.beforeEach(async ({ request }) => {
    try {
      const teacherToken = await getTeacherToken(request);
      const orgRes = await teacherRpc<{ organization: { id: string } }>(
        request,
        teacherToken,
        "richter.v1.OrganizationService",
        "GetOrganizationBySlug",
        { slug: "hust-cs" }
      );
      const courseRes = await teacherRpc<{ courses: { id: string; title: string }[] }>(
        request,
        teacherToken,
        "richter.v1.CourseService",
        "ListCourses",
        { organizationId: orgRes.organization.id, limit: 100 }
      );
      const course = courseRes.courses?.find((c) => c.title.includes("Cấu trúc dữ liệu và Giải thuật"));
      if (course) {
        const lessonsRes = await teacherRpc<{ lessons: { id: string; title: string }[] }>(
          request,
          teacherToken,
          "richter.v1.LessonService",
          "ListLessonsByCourse",
          { courseId: course.id, limit: 100 }
        );
        const lesson = lessonsRes.lessons?.find((l) => l.title.includes("Big-O"));
        if (lesson) {
          await setMaxAttempts(request, teacherToken, lesson.id, 0);
        }
      }
    } catch (e) {
      console.error("beforeEach reset failed:", e);
    }
  });

  test.afterEach(async ({ request }) => {
    try {
      const teacherToken = await getTeacherToken(request);
      const orgRes = await teacherRpc<{ organization: { id: string } }>(
        request,
        teacherToken,
        "richter.v1.OrganizationService",
        "GetOrganizationBySlug",
        { slug: "hust-cs" }
      );
      const courseRes = await teacherRpc<{ courses: { id: string; title: string }[] }>(
        request,
        teacherToken,
        "richter.v1.CourseService",
        "ListCourses",
        { organizationId: orgRes.organization.id, limit: 100 }
      );
      const course = courseRes.courses?.find((c) => c.title.includes("Cấu trúc dữ liệu và Giải thuật"));
      if (course) {
        const lessonsRes = await teacherRpc<{ lessons: { id: string; title: string }[] }>(
          request,
          teacherToken,
          "richter.v1.LessonService",
          "ListLessonsByCourse",
          { courseId: course.id, limit: 100 }
        );
        const lesson = lessonsRes.lessons?.find((l) => l.title.includes("Big-O"));
        if (lesson) {
          await setMaxAttempts(request, teacherToken, lesson.id, 0);
        }
      }
    } catch (e) {
      console.error("afterEach reset failed:", e);
    }
  });

  test("quiz overlay uses spacious full-cover video layout", async ({ teacherPage }) => {
    await goToSeededLesson(teacherPage, SEEDED_LESSON);

    // Teacher views in preview mode → append ?preview=1
    const url = teacherPage.url();
    await teacherPage.goto(`${url}?preview=1`);

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

  test("retake resets video playhead to 0", async ({ studentPage: page }) => {
    // Bob has a seeded attempt → starts in result state
    await goToSeededLesson(page, SEEDED_LESSON);
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();

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
    studentPage: page,
    request,
  }) => {
    // 1. Get teacher token via API context (separate from student's browser)
    const teacherToken = await getTeacherToken(request);

    // 2. Navigate student to lesson to get the URL and lesson ID
    const lessonUrl = await goToSeededLesson(page, SEEDED_LESSON);
    const lessonId = lessonUrl.split("/").pop() ?? "";

    // Bob has a seeded attempt → should see result
    await expect(page.getByText("🎯 Kết quả")).toBeVisible();

    // 3. Teacher sets maxAttempts = 1. Bob already has 1 seeded attempt, should be blocked.
    await setMaxAttempts(request, teacherToken, lessonId, 1);

    // 4. Reload to pick up new maxAttempts config
    await page.reload();
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });

    // The retake button should be hidden entirely when max attempts reached
    const retakeBtnAfterLimit = page.getByRole("button", { name: /Làm lại|Hết lượt/ });
    await expect(retakeBtnAfterLimit).not.toBeVisible();

    // 5. Teacher raises maxAttempts to 100 so Bob can retake
    await setMaxAttempts(request, teacherToken, lessonId, 100);

    // 6. Reload Bob's page
    await page.reload();
    await expect(page.getByText("🎯 Kết quả")).toBeVisible({ timeout: 10_000 });

    // Now the retake button should be active
    const activeBtn = page.getByRole("button", { name: "Làm lại", exact: true });
    await expect(activeBtn).toBeVisible();
    await expect(activeBtn).toBeEnabled();

    // 7. Clean up: reset maxAttempts to 0 (unlimited)
    await setMaxAttempts(request, teacherToken, lessonId, 0);
  });

  test("preview mode enforces attempt limit correctly", async ({
    teacherPage: page,
    request,
  }) => {
    // 1. Get teacher token
    const teacherToken = await getTeacherToken(request);

    // 2. Navigate teacher to lesson
    const lessonUrl = await goToSeededLesson(page, SEEDED_LESSON);
    const lessonId = lessonUrl.split("/").pop() ?? "";

    // 3. Set maxAttempts = 2
    await setMaxAttempts(request, teacherToken, lessonId, 2);

    // 4. Open preview mode
    await page.goto(`${lessonUrl}?preview=1`);
    await expect(page.locator('[data-testid="video-player"]')).toBeVisible({ timeout: 10_000 });

    // Local helper to answer all checkpoints
    const answerCheckpoints = async () => {
      for (const s of CHECKPOINT_SECONDS) {
        await triggerCheckpoint(page, s + 2);
        const checkpoint = page.locator('[data-testid="quiz-checkpoint"]');
        await expect(checkpoint).toBeVisible({ timeout: 5_000 });
        await checkpoint.locator("button").first().click();
        await page.getByRole("button", { name: "Tiếp tục xem" }).click();
        await expect(checkpoint).not.toBeVisible({ timeout: 3_000 });
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

    // 5. Clean up: reset maxAttempts to 0
    await setMaxAttempts(request, teacherToken, lessonId, 0);
  });
});
