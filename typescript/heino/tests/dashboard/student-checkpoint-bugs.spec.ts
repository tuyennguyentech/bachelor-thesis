/* eslint-disable react-hooks/rules-of-hooks */
// Tests for the four student-checkpoint bugs filed 2026-05-21:
//   A. Fill-blank long-hint placeholder truncation
//   B. Reading PreviewGrade transient errors
//   C. Listening AI-generated audio path
//   D. Cluster-local question numbering
//
// Strategy: use createAnalyzedLesson() in beforeAll to build an isolated
// course+module+lesson with a real video and transcript chunks. Each test
// mutates only the fresh lesson (feedback_mode + add/remove interactions),
// so the seeded "Bài 2: Phân tích đệ quy" lesson is never touched.

import { test as base, expect, createAnalyzedLesson } from "../fixtures";
import type { Page } from "@playwright/test";

const RICHTER_BASE = "/api/richter";
const LONG_HINT = "Hành động Chip lén lút giấu bài kiểm tra"; // 40 chars

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

async function setFeedbackMode(page: Page, lessonId: string, mode: string) {
  await rpc(page, "richter.v1.LessonService", "UpdateLessonFeedbackMode", {
    id: lessonId,
    feedbackMode: mode,
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

// ── Shared state (set in beforeAll, read by tests) ────────────────────────────

const freshLesson: LessonRef = { url: "", lessonId: "" };

// ── Tests ────────────────────────────────────────────────────────────────────

// Each test mutates the fresh lesson. Use a per-test fixture to restore
// feedback_mode and clean up created interactions regardless of pass/fail.
const test = base.extend<{ isolatedLesson: LessonRef }>({
  isolatedLesson: async ({ teacherPage }, use) => {
    const ref: LessonRef = { url: freshLesson.url, lessonId: freshLesson.lessonId };
    await use(ref);
    // Always restore feedback_mode after the test, even on failure.
    await setFeedbackMode(teacherPage, ref.lessonId, "FEEDBACK_MODE_AFTER_SUBMIT").catch(() => {});
  },
});

test.describe.serial("Student Checkpoint Bugs", () => {
  test.beforeAll(async () => {
    // Build a self-contained analyzed lesson: fresh course → module → lesson,
    // video uploaded via API, EXTRACT + CHUNK pipeline completed.
    // The lesson has a video_storage_key and at least one chunk — the student
    // view will render without needing any further video attachment.
    const { lessonUrl, lessonId } = await createAnalyzedLesson();
    freshLesson.url = lessonUrl;
    freshLesson.lessonId = lessonId;
  });

  test.describe("Bug A — Fill-blank input width", () => {
    test("long hint placeholder is fully visible (no truncation)", async ({
      teacherPage,
      isolatedLesson,
    }) => {
      await setFeedbackMode(teacherPage, isolatedLesson.lessonId, "FEEDBACK_MODE_AFTER_EACH");
      const createdIds: string[] = [];
      try {
        const fbId = await addInteraction(teacherPage, isolatedLesson.lessonId, {
          prompt: "Điền vào chỗ trống.",
          explanation: "",
          startSeconds: 3,
          fillBlank: {
            template: "Chíp đang {{0}} vì bị mẹ mắng.",
            blanks: [{ accepted: ["giấu bài"], caseSensitive: false, hint: LONG_HINT }],
          },
        });
        createdIds.push(fbId);

        await teacherPage.goto(`${isolatedLesson.url}?preview=1`);
        await expect(teacherPage.locator('[data-testid="video-player"]')).toBeAttached();
        await triggerCheckpoint(teacherPage, 4);

        // The added fill-blank fires at startSeconds=3 — it should be in the active
        // checkpoint cluster. Walk past any other interactions until we reach our
        // fill-blank input.
        let foundInput = false;
        for (let i = 0; i < 6 && !foundInput; i++) {
          if (await teacherPage.locator('[data-testid="fill-blank-input-0"]').count()) {
            foundInput = true;
            break;
          }
          // Try the other kind of question: pick first option and continue.
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
      isolatedLesson,
    }) => {
      await setFeedbackMode(teacherPage, isolatedLesson.lessonId, "FEEDBACK_MODE_AFTER_EACH");
      const createdIds: string[] = [];
      try {
        // 3 fill-blanks at the same start_seconds=4 so the student sees a cluster.
        for (let i = 0; i < 3; i++) {
          const id = await addInteraction(teacherPage, isolatedLesson.lessonId, {
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

        await teacherPage.goto(`${isolatedLesson.url}?preview=1`);
        await expect(teacherPage.locator('[data-testid="video-player"]')).toBeAttached();
        await triggerCheckpoint(teacherPage, 5);

        // Walk through any other questions first to reach our cluster (they may or
        // may not appear before ours). We expect at some point to see one of our
        // cluster prompts AND the label to read "Câu N/3" — cluster-local numbering.
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

  // P6 — a checkpoint the resumed position has already passed must re-surface on
  // load, not be silently skipped. Repro: seek past a gate, navigate away, come
  // back → the saved position is past the gate so the forward-crossing hit-test
  // never fires. The fix surfaces the earliest un-passed gate at/under the
  // resume position on mount. We simulate "seek past + navigate away" by
  // persisting a watch position beyond the gate via UpdateWatchProgress.
  test.describe("P6 — pending checkpoint survives navigation", () => {
    test("a gate the resumed position passed is re-surfaced on load", async ({
      teacherPage,
      isolatedLesson,
    }) => {
      await setFeedbackMode(teacherPage, isolatedLesson.lessonId, "FEEDBACK_MODE_AFTER_EACH");
      const createdIds: string[] = [];
      try {
        const gateId = await addInteraction(teacherPage, isolatedLesson.lessonId, {
          prompt: "Câu hỏi cổng P6.",
          explanation: "",
          startSeconds: 10,
          mcq: {
            options: [{ text: "Đáp án A" }, { text: "Đáp án B" }],
            correctAnswer: 0,
            correctAnswers: [],
            question: "",
          },
        });
        createdIds.push(gateId);

        // Persist a resume position PAST the 10s gate (as if the student seeked
        // past it then navigated to another lesson).
        await rpc(teacherPage, "richter.v1.AIService", "UpdateWatchProgress", {
          lessonId: isolatedLesson.lessonId,
          positionSeconds: 40,
          watchedFromSeconds: 0,
          watchedToSeconds: 0,
        });

        // Return to the lesson as a real (gated) learner.
        await teacherPage.goto(`${isolatedLesson.url}?mode=learn`, { waitUntil: "domcontentloaded" });

        // The skipped gate must re-surface on mount instead of being lost.
        await expect(teacherPage.getByTestId("quiz-checkpoint")).toBeVisible({ timeout: 15_000 });
        await expect(teacherPage.getByText("Câu hỏi cổng P6.")).toBeVisible();
      } finally {
        // Reset the persisted position so the shared lesson is clean for reruns.
        await rpc(teacherPage, "richter.v1.AIService", "UpdateWatchProgress", {
          lessonId: isolatedLesson.lessonId,
          positionSeconds: 0,
          watchedFromSeconds: 0,
          watchedToSeconds: 0,
        }).catch(() => {});
        await deleteInteractions(teacherPage, createdIds);
      }
    });
  });

  // P4 — rapid scrubbing past an unanswered gate must not freeze the page. The
  // old seek guard re-entered itself (writing currentTime inside a seek handler)
  // and rebuilt pendingCheckpoints every render, producing a synchronous storm
  // that locked the main thread. After the fix the page stays interactive.
  test.describe("P4 — rapid seeking stays responsive", () => {
    test("hammering seeks past a gate does not freeze the page", async ({
      teacherPage,
      isolatedLesson,
    }) => {
      await setFeedbackMode(teacherPage, isolatedLesson.lessonId, "FEEDBACK_MODE_AFTER_EACH");
      const createdIds: string[] = [];
      try {
        const gateId = await addInteraction(teacherPage, isolatedLesson.lessonId, {
          prompt: "Câu hỏi cổng P4.",
          explanation: "",
          startSeconds: 8,
          mcq: {
            options: [{ text: "A" }, { text: "B" }],
            correctAnswer: 0,
            correctAnswers: [],
            question: "",
          },
        });
        createdIds.push(gateId);

        await teacherPage.goto(`${isolatedLesson.url}?mode=learn`, { waitUntil: "domcontentloaded" });
        await expect(teacherPage.locator('[data-testid="video-player"]')).toBeAttached({ timeout: 15_000 });
        // Wait until the video can actually seek so currentTime writes register.
        await teacherPage.waitForFunction(() => {
          const v = document.querySelector("video");
          return !!v && v.readyState >= 1;
        }, { timeout: 15_000 }).catch(() => {});

        // Fast scrubbing far past the gate, many times in a tight burst — this is
        // what used to re-enter the seek guard into a synchronous storm. If the
        // main thread wedges (the old freeze), THIS evaluate never resolves and
        // the test fails on timeout. Completing it is the core freeze check.
        const burst = teacherPage.evaluate(async () => {
          const v = document.querySelector("video");
          if (!v) return false;
          for (let i = 0; i < 60; i++) {
            v.currentTime = 8 + (i % 12) * 40; // jump around well past the 8s gate
            v.dispatchEvent(new Event("seeking"));
            v.dispatchEvent(new Event("seeked"));
            await new Promise((r) => setTimeout(r, 3));
          }
          return true;
        });
        // Hard ceiling: a frozen thread would blow past this.
        const completed = await Promise.race([
          burst,
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000)),
        ]);
        expect(completed).toBe(true);

        // And the page is still INTERACTIVE afterwards: a stable control click
        // works (a frozen page would never resolve this).
        const exit = teacherPage.getByRole("link", { name: /Quay lại Studio/i }).first();
        await expect(exit).toBeVisible({ timeout: 8_000 });
        await exit.click({ timeout: 5_000 });
        await expect(teacherPage).not.toHaveURL(/mode=learn/, { timeout: 8_000 });
      } finally {
        await rpc(teacherPage, "richter.v1.AIService", "UpdateWatchProgress", {
          lessonId: isolatedLesson.lessonId,
          positionSeconds: 0,
          watchedFromSeconds: 0,
          watchedToSeconds: 0,
        }).catch(() => {});
        await deleteInteractions(teacherPage, createdIds);
      }
    });
  });
});

// Bug B — Reading PreviewGrade transient errors
// MediaRecorder không khả dụng trong headless Firefox nên không thể driver
// AudioRecorder UI để test. Backend graceful fallback đã được Go integ test cover.
