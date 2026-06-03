/* eslint-disable react-hooks/rules-of-hooks */
// Tests for the four student-checkpoint bugs filed 2026-05-21:
//   A. Fill-blank long-hint placeholder truncation
//   B. Reading PreviewGrade transient errors
//   C. Listening AI-generated audio path
//   D. Cluster-local question numbering
//
// Strategy: target the seeded "Bài 2: Phân tích đệ quy" lesson, which already
// has analysis.status=done (required for the student view to render its
// interactions). We mutate it for each test (feedback_mode + add reading /
// fill-blank), then clean up so other suites aren't disturbed.

import { test as base, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const SEEDED_LESSON_TITLE = "Bài 2: Phân tích đệ quy với Master Theorem";
const RICHTER_BASE = "/api/richter";
const LONG_HINT = "Hành động Chip lén lút giấu bài kiểm tra"; // 40 chars
const TEST_VIDEO = path.join(__dirname, "../fixtures/test-video.mp4");

// ── RPC helpers ──────────────────────────────────────────────────────────────

async function bearer(page: Page): Promise<string> {
  const c = (await page.context().cookies()).find((c) => c.name === "dyadia_access");
  if (!c) throw new Error("dyadia_access cookie missing — page not logged in");
  return c.value;
}

async function rpc<T = unknown>(
  page: Page,
  service: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await bearer(page);
  const res = await page.request.post(`${RICHTER_BASE}/${service}/${method}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(`RPC ${service}.${method} -> HTTP ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface LessonRef {
  url: string;
  lessonId: string;
}

// Look up the seeded recurrence lesson by walking the dashboard, then return
// its URL + id. We avoid hard-coding UUIDs because seed UUIDs are non-stable.
async function findRecurrenceLesson(page: Page): Promise<LessonRef> {
  await page.goto("/dashboard/organizations/hust-cs/courses?q=Cấu+trúc+dữ+liệu");
  const row = page.getByRole("row").filter({ hasText: "Cấu trúc dữ liệu" });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error("Course link not found");
  await page.goto(courseHref);
  const lessonLink = page.getByRole("link").filter({ hasText: SEEDED_LESSON_TITLE }).first();
  const lessonHref = await lessonLink.getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson link not found for "${SEEDED_LESSON_TITLE}"`);
  const id = lessonHref.split("/").pop() ?? "";
  return { url: lessonHref, lessonId: id };
}

async function setFeedbackMode(page: Page, lessonId: string, mode: string) {
  await rpc(page, "richter.v1.LessonService", "UpdateLessonFeedbackMode", {
    id: lessonId,
    feedbackMode: mode,
  });
}

// StudentLessonView only renders when lesson.videoStorageKey is set. We attach
// the existing seeded Big-O video to the Recurrence lesson so the student view
// mounts. Only call when the lesson has no video yet — UpdateLessonVideo wipes
// analysis/interactions whenever a video already exists, even on a same-key
// "update" (lessons.go:378), so calling unconditionally between tests would
// destroy our test fixture's interactions.
async function ensureVideoAttached(page: Page, lessonId: string) {
  const res = await rpc<{ lesson: { videoStorageKey?: string } }>(
    page,
    "richter.v1.LessonService",
    "GetLessonById",
    { id: lessonId },
  );
  if (res.lesson?.videoStorageKey) return; // already attached, leave it
  const videoStorageKey = `lessons/${lessonId}/video/test-video.mp4`;
  const upload = await rpc<{ uploadUrl: string }>(
    page,
    "richter.v1.StorageService",
    "GetUploadUrl",
    { key: videoStorageKey, contentType: "video/mp4", expiresInSeconds: 3600 },
  );
  const putRes = await page.request.put(upload.uploadUrl, {
    headers: { "Content-Type": "video/mp4" },
    data: fs.readFileSync(TEST_VIDEO),
  });
  if (!putRes.ok()) {
    throw new Error(`PUT lesson test video -> HTTP ${putRes.status()} ${await putRes.text()}`);
  }
  await rpc(page, "richter.v1.LessonService", "UpdateLessonVideo", {
    id: lessonId,
    videoStorageKey,
    durationSeconds: 60,
  });
}

async function addInteraction(
  page: Page,
  lessonId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await rpc<{ interaction: { id: string } }>(
    page,
    "richter.v1.InteractionService",
    "CreateManualInteraction",
    { lessonId, ...body },
  );
  return res.interaction.id;
}

async function deleteInteractions(page: Page, ids: string[]) {
  for (const id of ids) {
    try {
      await rpc(page, "richter.v1.InteractionService", "DeleteInteraction", { interactionId: id });
    } catch {
      // Best-effort cleanup
    }
  }
}

async function triggerCheckpoint(page: Page, seconds: number) {
  await page.waitForFunction(() => "__triggerVideoCheckpoint" in window, { timeout: 5_000 });
  await page.evaluate((s) => {
    (window as unknown as { __triggerVideoCheckpoint: (s: number) => void }).__triggerVideoCheckpoint(s);
  }, seconds);
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Each test in this file mutates the seeded lesson. Use a serial-style
// cleanup pattern to restore state, regardless of pass/fail.
const test = base.extend<{ recurrenceLesson: LessonRef }>({
  recurrenceLesson: async ({ teacherPage }, use) => {
    const ref = await findRecurrenceLesson(teacherPage);
    await use(ref);
    // Always restore feedback_mode after the test, even on failure.
    await setFeedbackMode(teacherPage, ref.lessonId, "FEEDBACK_MODE_AFTER_SUBMIT").catch(() => {});
  },
});

test.describe("Bug A — Fill-blank input width", () => {
  test("long hint placeholder is fully visible (no truncation)", async ({
    teacherPage,
    recurrenceLesson,
  }) => {
    await ensureVideoAttached(teacherPage, recurrenceLesson.lessonId);
    await setFeedbackMode(teacherPage, recurrenceLesson.lessonId, "FEEDBACK_MODE_AFTER_EACH");
    const createdIds: string[] = [];
    try {
      const fbId = await addInteraction(teacherPage, recurrenceLesson.lessonId, {
        prompt: "Điền vào chỗ trống.",
        explanation: "",
        startSeconds: 3,
        fillBlank: {
          template: "Chíp đang {{0}} vì bị mẹ mắng.",
          blanks: [{ accepted: ["giấu bài"], caseSensitive: false, hint: LONG_HINT }],
        },
      });
      createdIds.push(fbId);

      await teacherPage.goto(`${recurrenceLesson.url}?preview=1`);
      await expect(teacherPage.locator('[data-testid="video-player"]')).toBeAttached();
      await triggerCheckpoint(teacherPage, 4);

      // The added fill-blank fires at startSeconds=3 — it should be in the active
      // checkpoint cluster. Other (seeded MCQ) interactions may also be present;
      // walk past them until we reach our fill-blank input.
      let foundInput = false;
      for (let i = 0; i < 6 && !foundInput; i++) {
        if (await teacherPage.locator('[data-testid="fill-blank-input-0"]').count()) {
          foundInput = true;
          break;
        }
        // Try the seeded MCQ: pick the first option and continue.
        const cp = teacherPage.locator('[data-testid="quiz-checkpoint"]');
        if (await cp.count()) {
          const opt = cp.locator("button").filter({ hasText: /./ }).first();
          if (await opt.count()) await opt.click();
          const cont = teacherPage.getByRole("button", { name: /Câu tiếp theo|Tiếp tục xem/ });
          if (await cont.count()) await cont.click();
          await teacherPage.waitForTimeout(200);
        }
      }

      expect(foundInput).toBe(true);
      const input = teacherPage.locator('[data-testid="fill-blank-input-0"]');
      const dims = await input.evaluate((el: HTMLInputElement) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        placeholder: el.placeholder,
        styleWidth: el.style.width,
      }));
      expect(dims.placeholder).toBe(LONG_HINT);
      // Width set in `ch` should accommodate the full hint with no overflow.
      expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
      expect(dims.styleWidth).toMatch(/^\d+ch$/);
    } finally {
      await deleteInteractions(teacherPage, createdIds);
    }
  });
});

test.describe("Bug D — Cluster-local question numbering", () => {
  test("interactions sharing a start_seconds are numbered 1/N of the cluster", async ({
    teacherPage,
    recurrenceLesson,
  }) => {
    await ensureVideoAttached(teacherPage, recurrenceLesson.lessonId);
    await setFeedbackMode(teacherPage, recurrenceLesson.lessonId, "FEEDBACK_MODE_AFTER_EACH");
    const createdIds: string[] = [];
    try {
      // 3 fill-blanks at the same start_seconds=4 so the student sees a cluster.
      for (let i = 0; i < 3; i++) {
        const id = await addInteraction(teacherPage, recurrenceLesson.lessonId, {
          prompt: `Câu hỏi cụm số ${i + 1}.`,
          explanation: "",
          startSeconds: 4,
          fillBlank: {
            template: `Chíp {{0}} (trong cụm ${i + 1}).`,
            blanks: [{ accepted: [String(i + 1)], caseSensitive: false, hint: `hint ${i + 1}` }],
          },
        });
        createdIds.push(id);
      }

      await teacherPage.goto(`${recurrenceLesson.url}?preview=1`);
      await expect(teacherPage.locator('[data-testid="video-player"]')).toBeAttached();
      await triggerCheckpoint(teacherPage, 5);

      // Walk through any seeded MCQs first to reach our cluster (their start
      // seconds are >= 0; they may or may not appear before ours). We expect
      // at some point to see one of our cluster prompts AND the label to read
      // "Câu N/3" — that means cluster-local numbering is in effect.
      let sawClusterLabel = false;
      for (let i = 0; i < 10 && !sawClusterLabel; i++) {
        const cp = teacherPage.locator('[data-testid="quiz-checkpoint"]');
        if (!(await cp.count())) break;
        const label = await cp.locator("text=/Câu \\d+\\/\\d+/").first().textContent();
        if (label && /Câu \d+\/3/.test(label)) {
          sawClusterLabel = true;
          break;
        }
        // Try fill-blank first, fall back to MCQ.
        const fbInput = cp.locator('[data-testid="fill-blank-input-0"]').first();
        if (await fbInput.count()) {
          await fbInput.fill("1");
          await teacherPage.getByRole("button", { name: "Trả lời" }).click();
        } else {
          const opt = cp.locator("button").filter({ hasText: /./ }).first();
          if (await opt.count()) await opt.click();
        }
        const cont = teacherPage.getByRole("button", { name: /Câu tiếp theo|Tiếp tục xem/ });
        if (await cont.count()) await cont.click();
        await teacherPage.waitForTimeout(150);
      }

      expect(sawClusterLabel).toBe(true);
    } finally {
      await deleteInteractions(teacherPage, createdIds);
    }
  });
});

// Bug B — Reading PreviewGrade transient errors
// MediaRecorder không khả dụng trong headless Firefox nên không thể driver
// AudioRecorder UI để test. Backend graceful fallback đã được Go integ test cover.
