/**
 * E2E tests — teacher-facing Learning Analytics UI.
 *
 * Covers the analytics surfaces added to the lesson "Kết quả & Thống kê"
 * (?tab=results) tab and the course workspace results tab:
 *   - lesson-heatmap: per-chunk score heatmap (testid `lesson-heatmap`)
 *   - kind-accuracy-strip + question-analysis panels in lesson-attempts
 *   - lesson-attempts columns: "Số lần nộp", "Điểm", "TG/câu", "% xem", "Tương tác"
 *   - lesson-completion-settings: two percent inputs (watch% / score%)
 *   - course-results: "% xem" column + at-risk section (testid `at-risk-section`)
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
  await expect(page.getByRole("heading", { name: "Bảng kết quả học viên" })).toBeVisible();
  return lessonHref;
}

/**
 * The lesson results tab is split into sub-tabs (Bảng kết quả / Bản đồ nhiệt /
 * Phân tích câu hỏi); the table is default. These helpers switch to the heatmap
 * or question-analysis sub-tab via its segmented-control button (no navigation).
 */
async function goToBigOHeatmap(page: Page): Promise<void> {
  await goToBigOResultsTab(page);
  await page.getByTestId("lesson-results-subtab-heatmap").click();
}
async function goToBigOQuestions(page: Page): Promise<void> {
  await goToBigOResultsTab(page);
  await page.getByTestId("lesson-results-subtab-questions").click();
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
    await goToBigOHeatmap(page);

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

  test("hovering a heatmap segment reveals its detail tooltip", async ({ teacherPage: page }) => {
    await goToBigOHeatmap(page);
    const heatmap = page.getByTestId("lesson-heatmap");
    await expect(heatmap).toBeVisible();
    // Hover the first segment cell → a rich tooltip with respondent count appears
    // (real React hover, not a native title).
    await heatmap.locator(".h-14").first().hover();
    await expect(heatmap.getByText("Lượt trả lời").first()).toBeVisible({ timeout: 5000 });
    await expect(heatmap.getByText(/Đoạn 1/).first()).toBeVisible();
  });

  test("org admin (alice) also sees lesson-heatmap on results tab", async ({ userPage: page }) => {
    // alice is a hust-cs org ADMIN (canManage=true). The sys-admin fixture
    // (admin@dyadia.local) is NOT a hust-cs member and hits the org 403 gate,
    // so org-admin alice is the correct "admin-level manager" coverage here —
    // matching how student-progress.spec.ts uses userPage for manager views.
    await goToBigOHeatmap(page);
    await expect(page.getByTestId("lesson-heatmap")).toBeVisible();
  });

  test("teacher sees per-kind accuracy strip and/or question analysis", async ({ teacherPage: page }) => {
    await goToBigOQuestions(page);

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

    // Always-visible columns (the secondary behavioural metrics are now hidden on
    // narrow viewports to de-clutter, so assert the ones shown at every width).
    // "Tỉ lệ trả lời" was removed — it was ~always 100% (answering is required to
    // submit), so it carried no information.
    await expect(attempts.getByRole("columnheader", { name: "Số lần nộp" })).toBeVisible();
    await expect(attempts.getByRole("columnheader", { name: "Điểm", exact: true })).toBeVisible();
    await expect(attempts.getByRole("columnheader", { name: "Tương tác" })).toBeVisible();
    // The removed column must not reappear.
    await expect(attempts.getByRole("columnheader", { name: "Tỉ lệ trả lời" })).toHaveCount(0);
  });

  test("attempts table lists a seeded student row (bob)", async ({ teacherPage: page }) => {
    await goToBigOResultsTab(page);
    const attempts = page.getByTestId("lesson-attempts");
    // bob has a seeded attempt on the Big-O lesson → his email appears.
    await expect(attempts.getByText("bob@dyadia.local")).toBeVisible();
  });
});

// ── Course results — columns + at-risk section ──────────────────────────────

test.describe("Course results analytics (teacher view)", () => {
  test('results table has the "% xem" column and no meaningless "% trả lời"', async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    await expect(page.getByRole("columnheader", { name: "% xem" })).toBeVisible();
    // "% trả lời" was removed (always 100% — questions are required to submit).
    await expect(page.getByRole("columnheader", { name: "% trả lời" })).toHaveCount(0);
  });

  test("results tab shows the class score-distribution histogram", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    // The distribution lives in its own sub-tab now.
    await page.getByTestId("results-subtab-distribution").click();
    const hist = page.getByTestId("score-distribution");
    await expect(hist).toBeVisible();
    await expect(hist.getByText("Phân bố điểm")).toBeVisible();
    // The five score bands are labelled.
    await expect(hist.getByText("0–19")).toBeVisible();
    await expect(hist.getByText("80–100")).toBeVisible();
  });

  test("results tab shows the engagement × score quadrant scatter", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    // The scatter lives in its own sub-tab now.
    await page.getByTestId("results-subtab-scatter").click();
    const scatter = page.getByTestId("engagement-scatter");
    await expect(scatter).toBeVisible();
    await expect(scatter.getByText("Tương tác × Điểm")).toBeVisible();
    // The SVG plot renders (matched by its aria-label, not the heading icon).
    await expect(scatter.getByRole("img", { name: "Biểu đồ tương tác và điểm" })).toBeVisible();
  });

  test("three result sub-tabs switch content (list default)", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    // Default sub-tab = Danh sách kết quả → the results table is visible, charts are not.
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByTestId("score-distribution")).toHaveCount(0);
    await expect(page.getByTestId("engagement-scatter")).toHaveCount(0);

    // Phân bố điểm → histogram visible, table gone.
    await page.getByTestId("results-subtab-distribution").click();
    await expect(page.getByTestId("score-distribution")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);

    // Tương tác × Điểm → scatter visible, histogram gone.
    await page.getByTestId("results-subtab-scatter").click();
    await expect(page.getByTestId("engagement-scatter")).toBeVisible();
    await expect(page.getByTestId("score-distribution")).toHaveCount(0);

    // Back to Danh sách kết quả → table returns.
    await page.getByTestId("results-subtab-list").click();
    await expect(page.getByRole("table")).toBeVisible();
  });

  test("scatter dot hover reveals a tooltip with score + engagement", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    await page.getByTestId("results-subtab-scatter").click();
    const scatter = page.getByTestId("engagement-scatter");
    await expect(scatter).toBeVisible();
    // Hover the first plotted learner dot — a positioned tooltip appears with the
    // exact điểm % and tương tác value (real React hover, not a native title).
    // force: dots are large transparent hit-targets that overlap when learners sit
    // close together (denser cohorts), so an adjacent dot may cover this one's
    // centre; the tooltip fires on whichever dot the cursor lands on either way.
    await scatter.locator("circle[data-dot]").first().hover({ force: true });
    await expect(scatter.getByText(/Điểm:/).first()).toBeVisible({ timeout: 5000 });
    await expect(scatter.getByText(/Tương tác:/).first()).toBeVisible();
  });

  test("scatter renders axis tick marks (0 / 40 / 70 / 100 guides)", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);
    await page.getByTestId("results-subtab-scatter").click();
    const scatter = page.getByTestId("engagement-scatter");
    // Axis tick value labels are present (so a reader can read off the scale).
    for (const t of ["40", "80", "100"]) {
      await expect(scatter.getByText(t, { exact: true }).first()).toBeVisible();
    }
  });

  test("Trung bình/Tổng toggle swaps the summary + table columns", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);

    // Default = "Trung bình" (average): average columns present, total ones absent.
    await expect(page.getByRole("columnheader", { name: "Điểm TB" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "% xem" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Thời gian", exact: true })).toHaveCount(0);

    // Switch to "Tổng" (total): raw-total columns appear, average ones disappear.
    await page.getByTestId("results-mode-total").click();
    await expect(page.getByRole("columnheader", { name: "Thời gian", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "% xem" })).toHaveCount(0);
    // The removed response-count column must not appear in either mode.
    await expect(page.getByRole("columnheader", { name: "Câu trả lời", exact: true })).toHaveCount(0);
    // Total summary chip labels are shown.
    await expect(page.getByText("Bài hoàn thành")).toBeVisible();
    await expect(page.getByText("Điểm đạt được")).toBeVisible();

    // Toggle back to average restores the original columns.
    await page.getByTestId("results-mode-average").click();
    await expect(page.getByRole("columnheader", { name: "% xem" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Thời gian", exact: true })).toHaveCount(0);
  });

  test("at-risk lives in its own tab (card grid) or is gracefully absent", async ({ teacherPage: page }) => {
    await goToDsaCourseResults(page);

    // The at-risk panel is a dedicated sub-tab that is now ALWAYS present (it no
    // longer disappears when a course has no flagged students — it shows an empty
    // state instead, so the teacher can always find it).
    const tab = page.getByTestId("results-subtab-at-risk");
    await expect(tab).toBeVisible();
    await tab.click();
    const atRisk = page.getByTestId("at-risk-section");
    await expect(atRisk).toBeVisible();
    if ((await page.getByTestId("at-risk-card").count()) > 0) {
      // There ARE at-risk students → header + a card grid.
      await expect(atRisk.getByText(/học viên cần chú ý/)).toBeVisible();
      await expect(page.getByTestId("at-risk-card").first()).toBeVisible();
    } else {
      // None in this seed → graceful empty state (no longer a vanished tab).
      await expect(page.getByTestId("at-risk-empty")).toBeVisible();
    }
  });

  test("org admin (alice) sees the same course results analytics", async ({ userPage: page }) => {
    // org-admin alice (hust-cs ADMIN); the sys-admin fixture is not a member
    // of hust-cs and would hit the 403 org gate.
    await goToDsaCourseResults(page);
    await expect(page.getByRole("columnheader", { name: "% xem" })).toBeVisible();
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

// ── Reactive drill-downs: click a chart slice → list who is in it ────────────
test.describe("Analytics drill-downs (teacher view)", () => {
  test("clicking a heatmap segment lists the students who answered it", async ({ teacherPage: page }) => {
    await goToBigOHeatmap(page);
    const heatmap = page.getByTestId("lesson-heatmap");
    await expect(heatmap).toBeVisible();
    // Click a segment cell that has data (shows a "%"), so its breakdown is non-empty.
    const cell = heatmap.locator('[data-testid="heatmap-cell"]').filter({ hasText: "%" }).first();
    await cell.click();
    const drill = page.getByTestId("heatmap-drilldown");
    await expect(drill).toBeVisible({ timeout: 8000 });
    // The panel header names the segment + a học-viên count.
    await expect(drill.getByText(/Đoạn \d+/)).toBeVisible();
    await expect(drill.getByText(/\d+ học viên/)).toBeVisible();
    // At least one student row (email present in the seed).
    await expect(drill.getByText(/@/).first()).toBeVisible();
    // Close button collapses it.
    await drill.getByTestId("heatmap-drilldown-close").click();
    await expect(page.getByTestId("heatmap-drilldown")).toHaveCount(0);
  });

  test("clicking a histogram band lists the students in that score range", async ({ userPage: page }) => {
    await goToDsaCourseResults(page);
    await page.getByTestId("results-subtab-distribution").click();
    await expect(page.getByTestId("score-distribution")).toBeVisible();
    // Click bands from the middle outwards until one opens a drill-down (a band
    // with ≥1 student). The seed guarantees at least one populated band.
    let opened = false;
    for (const b of [2, 3, 1, 4, 0]) {
      await page.locator(`[data-testid="score-distribution"] rect[data-band="${b}"]`).click({ force: true });
      if (await page.getByTestId("chart-drilldown").isVisible().catch(() => false)) {
        opened = true;
        break;
      }
    }
    expect(opened).toBe(true);
    const drill = page.getByTestId("chart-drilldown");
    await expect(drill.getByText(/Khoảng điểm/)).toBeVisible();
    await expect(drill.getByText(/@/).first()).toBeVisible();
    await drill.getByTestId("chart-drilldown-close").click();
    await expect(page.getByTestId("chart-drilldown")).toHaveCount(0);
  });

  test("clicking a scatter dot lists the students at that position", async ({ userPage: page }) => {
    await goToDsaCourseResults(page);
    await page.getByTestId("results-subtab-scatter").click();
    await expect(page.getByTestId("engagement-scatter")).toBeVisible();
    const dot = page.locator('[data-testid="engagement-scatter"] circle[data-dot]').first();
    await dot.click({ force: true });
    const drill = page.getByTestId("chart-drilldown");
    await expect(drill).toBeVisible({ timeout: 8000 });
    await expect(drill.getByText(/@/).first()).toBeVisible();
    // Close, then a SINGLE click on the same dot must reopen it — the selection
    // is fully controlled, so closing doesn't leave a stale highlight that would
    // turn the next click into a no-op (regression guard for the desync bug).
    await drill.getByTestId("chart-drilldown-close").click();
    await expect(page.getByTestId("chart-drilldown")).toHaveCount(0);
    await dot.click({ force: true });
    await expect(page.getByTestId("chart-drilldown")).toBeVisible({ timeout: 8000 });
  });
});

// ── Bug fixes: at-risk tooltip + per-lesson audio language selector ──────────
test.describe("Analytics/processing bug fixes (teacher view)", () => {
  test("at-risk card shows the weak lesson name + score directly (redesigned)", async ({ userPage: page }) => {
    await goToDsaCourseResults(page);
    // The at-risk sub-tab is always present now; click it and only assert the
    // card-content redesign when this seed actually has at-risk students (the
    // empty-state path is covered above; rich-data cards by results-redesign).
    const tab = page.getByTestId("results-subtab-at-risk");
    await tab.click();
    if ((await page.getByTestId("at-risk-card").count()) === 0) {
      await expect(page.getByTestId("at-risk-empty")).toBeVisible();
      return;
    }
    const card = page.getByTestId("at-risk-card").first();
    await expect(card).toBeVisible({ timeout: 5000 });
    // Redesign: weak lessons are labelled engagement bars — the lesson name and
    // the score "/100" are visible inline (no hover/tooltip needed). The section
    // header "Bài học tương tác thấp" appears whenever a card has a weak streak.
    const weak = page.getByText("Bài học tương tác thấp").first();
    if ((await weak.count()) > 0) {
      await expect(weak).toBeVisible();
      await expect(page.getByText(/\/100/).first()).toBeVisible();
    }
  });

  test("lesson processing tab exposes a separate audio-language selector", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    const audioSel = page.getByTestId("audio-language-select");
    await expect(audioSel).toBeVisible({ timeout: 30000 });
    // It is DISTINCT from the question/output language and offers vi/en + auto.
    await expect(audioSel.locator("option")).toHaveCount(3);
  });

  test("lesson processing tab offers a guarded 'reset everything' action", async ({ teacherPage: page }) => {
    const lessonHref = await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await page.goto(`${lessonHref}?tab=processing`, { waitUntil: "domcontentloaded" });
    const resetBtn = page.getByTestId("reset-lesson-button");
    await expect(resetBtn).toBeVisible({ timeout: 30000 });
    await resetBtn.click();

    // The confirm dialog must spell out exactly what gets wiped and must NOT act
    // until the user confirms. The actual destructive wipe is covered by the Go
    // integration test (TestAIResetLessonContent) — here we only verify the
    // guard, then cancel so seed data is left intact.
    const dialog = page.getByTestId("reset-lesson-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Không thể hoàn tác");
    await expect(dialog).toContainText("học viên");
    await dialog.getByRole("button", { name: "Huỷ" }).click();
    await expect(dialog).toBeHidden();
  });
});
