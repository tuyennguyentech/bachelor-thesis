/**
 * E2E tests — teacher-facing Learning Analytics UI.
 *
 * Covers the analytics surfaces added to the lesson "Kết quả & Thống kê"
 * (?tab=results) tab and the course workspace results tab:
 *   - lesson-heatmap: per-chunk score heatmap (testid `lesson-heatmap`)
 *   - kind-accuracy-strip + question-analysis panels in lesson-attempts
 *   - lesson-attempts new columns: "Tỉ lệ trả lời", "Tổng TG làm", "Nghe lại TB"
 *   - lesson-completion-settings: two percent inputs (watch% / score%)
 *   - course-results: "% trả lời" column + at-risk section (testid `at-risk-section`)
 *
 * Seed reference (golang/richter/internal/seed/data/dev/quiz_attempts.json):
 *   The DSA Big-O lesson (hust-cs) has 5 seeded attempts (bob, dave, eve, grace,
 *   iris), so the heatmap / per-kind / question analytics are populated. The
 *   DSA course has several students with attempts, so the course results table
 *   has multiple rows. The at-risk section is conditional (only renders when
 *   ListAtRiskStudents returns rows) — tests assert it gracefully.
 *
 * Gating: these surfaces require effectiveCanManage (OWNER/ADMIN/TEACHER and
 * not in ?preview mode). carol (teacherPage) is a hust-cs TEACHER; alice
 * (userPage) is a hust-cs org ADMIN; eve (pureStudentPage) is student-only and
 * must NOT see them.
 */

import {
  test,
  expect,
  goToSeededLesson,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
  SEED_DSA_LESSON_BIG_O,
} from "../fixtures";
import type { Page } from "@playwright/test";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

/**
 * Navigate to the seeded Big-O lesson's results tab (?tab=results).
 * Returns the lesson base URL (without the tab query).
 */
async function goToBigOResultsTab(page: Page): Promise<string> {
  const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
  await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });
  // The results tab body (lesson-attempts container) is rendered server-side
  // when effectiveCanManage && attemptsData is present.
  await expect(page.getByRole("heading", { name: "Điều kiện hoàn thành" })).toBeVisible();
  return lessonHref;
}

/**
 * Navigate to the DSA course workspace results tab (?tab=results).
 */
async function goToDsaCourseResults(page: Page): Promise<void> {
  await page.goto(
    `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
    { waitUntil: "domcontentloaded" },
  );
  const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
  const href = await card.getByRole("link").first().getAttribute("href");
  if (!href) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" link not found`);
  // Strip any query (the manager card CTA links to ...?mode=learn) before adding the tab.
  await page.goto(`${href.split("?")[0].replace(/\/$/, "")}?tab=results`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Kết quả học viên")).toBeVisible();
}

// ── Lesson results tab — heatmap + analytics panels ─────────────────────────

test.describe("Lesson analytics — heatmap & question analytics (teacher view)", () => {
  test("teacher sees lesson-heatmap with chunk segments on results tab", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);

    const heatmap = page.getByTestId("lesson-heatmap");
    await expect(heatmap).toBeVisible();
    // Each chunk renders a min-w-[28px] column with a mm:ss start label.
    // Assert at least one segment time label is present (heatmap is non-empty
    // for the Big-O lesson which has 5 seeded attempts).
    await expect(heatmap.getByText(/^\d+:\d{2}$/).first()).toBeVisible();
    // The legend ("≥ 80%") confirms the heatmap rendered fully, not the
    // "Chưa đủ dữ liệu" empty fallback.
    await expect(heatmap.getByText("≥ 80%")).toBeVisible();
  });

  test("org admin (alice) also sees lesson-heatmap on results tab", async ({ userPage: page }) => {
    // alice is a hust-cs org ADMIN (canManage=true). The sys-admin fixture
    // (admin@dyadia.local) is NOT a hust-cs member and hits the org 403 gate,
    // so org-admin alice is the correct "admin-level manager" coverage here —
    // matching how student-progress.spec.ts uses userPage for manager views.
    await goToBigOResultsTab(page);
    await expect(page.getByTestId("lesson-heatmap")).toBeVisible();
  });

  test("teacher sees per-kind accuracy strip and/or question analysis", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);

    // The Big-O lesson has MCQ interactions with seeded responses, so at least
    // one of the analytics panels should render. Assert at least one is visible
    // rather than requiring both (robust to which kinds got responses).
    const strip = page.getByTestId("kind-accuracy-strip");
    const questions = page.getByTestId("question-analysis");
    const stripVisible = await strip.isVisible().catch(() => false);
    const questionsVisible = await questions.isVisible().catch(() => false);
    expect(stripVisible || questionsVisible).toBeTruthy();

    if (questionsVisible) {
      // Question analysis renders its heading + per-question cards.
      await expect(page.getByRole("heading", { name: "Phân tích câu hỏi" })).toBeVisible();
    }
  });
});

// ── Lesson attempts table — new columns ─────────────────────────────────────

test.describe("Lesson attempts table — new analytics columns (teacher view)", () => {
  test("attempts table shows new column headers", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);

    const attempts = page.getByTestId("lesson-attempts");
    await expect(attempts).toBeVisible();

    // New columns added to lesson-attempts.tsx.
    await expect(attempts.getByRole("columnheader", { name: "Tỉ lệ trả lời" })).toBeVisible();
    await expect(attempts.getByRole("columnheader", { name: "Tổng TG làm" })).toBeVisible();
    await expect(attempts.getByRole("columnheader", { name: "Nghe lại TB" })).toBeVisible();
  });

  test("attempts table lists a seeded student row (bob)", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);
    const attempts = page.getByTestId("lesson-attempts");
    // bob has a seeded attempt on the Big-O lesson → his email appears.
    await expect(attempts.getByText("bob@dyadia.local")).toBeVisible();
  });
});

// ── Lesson completion settings ──────────────────────────────────────────────

test.describe("Lesson completion settings (teacher view)", () => {
  test("two percent inputs are visible with default-ish values", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);

    const watchInput = page.locator("#min-watch-pct");
    const scoreInput = page.locator("#min-score-pct");
    await expect(watchInput).toBeVisible();
    await expect(scoreInput).toBeVisible();

    // Inputs are number type and editable (not disabled).
    await expect(watchInput).toHaveAttribute("type", "number");
    await expect(scoreInput).toHaveAttribute("type", "number");
    await expect(watchInput).toBeEnabled();
    await expect(scoreInput).toBeEnabled();

    // Labels confirm the meaning of each input.
    await expect(page.getByText("Xem video tối thiểu (%)")).toBeVisible();
    await expect(page.getByText("Điểm tối thiểu (%)")).toBeVisible();
  });

  test("editing a percent input and saving shows no error", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);

    const watchInput = page.locator("#min-watch-pct");
    await expect(watchInput).toBeVisible();

    // Set a deterministic valid value, then save.
    await watchInput.fill("75");
    await expect(watchInput).toHaveValue("75");

    await page.getByRole("button", { name: "Lưu" }).click();

    // Success: the "Đã lưu" confirmation appears. The action also revalidates,
    // so wait for the in-place confirmation rather than re-navigating.
    await expect(page.getByText("Đã lưu")).toBeVisible({ timeout: 10_000 });
    // No red error text under the form.
    await expect(page.locator("p.text-red-600")).toHaveCount(0);
  });
});

// ── Course results — % trả lời column + at-risk section ─────────────────────

test.describe("Course results analytics (teacher view)", () => {
  test('results table has the "% trả lời" column', async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    await expect(page.getByRole("columnheader", { name: "% trả lời" })).toBeVisible();
  });

  test("at-risk section renders or is gracefully absent", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);

    const atRisk = page.getByTestId("at-risk-section");
    if ((await atRisk.count()) > 0) {
      // When present it shows the red "Cần chú ý (n)" header.
      await expect(atRisk).toBeVisible();
      await expect(atRisk.getByText(/Cần chú ý \(\d+\)/)).toBeVisible();
    } else {
      // Conditional section is absent for this seed — assert the table still
      // renders with the response-rate column so the page is functional.
      await expect(page.getByRole("columnheader", { name: "% trả lời" })).toBeVisible();
    }
  });

  test("org admin (alice) sees the same course results analytics", async ({ userPage: page }) => {
    // org-admin alice (hust-cs ADMIN); the sys-admin fixture is not a member
    // of hust-cs and would hit the 403 org gate.
    await goToDsaCourseResults(page);
    await expect(page.getByRole("columnheader", { name: "% trả lời" })).toBeVisible();
  });
});

// ── Negative check — pure student does not see teacher analytics ────────────

test.describe("Pure student does NOT see teacher analytics", () => {
  test("eve does not see lesson-heatmap on the Big-O lesson", async ({ pureStudentPage: page }) => {
    // eve is enrolled in the DSA course as a student. The results-tab analytics
    // are gated on effectiveCanManage, which is false for her, so the student
    // lesson view renders instead — the heatmap testid must be absent.
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=results`, { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("lesson-heatmap")).toHaveCount(0);
    await expect(page.getByTestId("lesson-attempts")).toHaveCount(0);
    // Completion-settings teacher control must also be absent.
    await expect(page.getByRole("heading", { name: "Điều kiện hoàn thành" })).not.toBeVisible();
  });

  test("eve does not see Kết quả học viên on the DSA course workspace", async ({ pureStudentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    const href = await card.getByRole("link").first().getAttribute("href");
    if (!href) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" link not found`);
    // Strip any query (the manager card CTA links to ...?mode=learn) before adding the tab.
    await page.goto(`${href.split("?")[0].replace(/\/$/, "")}?tab=results`, { waitUntil: "domcontentloaded" });

    // canManage=false → the course results section is not rendered.
    await expect(page.getByText("Kết quả học viên")).not.toBeVisible();
    await expect(page.getByTestId("at-risk-section")).toHaveCount(0);
  });
});
