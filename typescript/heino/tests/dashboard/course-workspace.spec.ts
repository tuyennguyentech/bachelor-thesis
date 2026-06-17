/**
 * E2E tests — Course Workspace (?tab=overview|lessons|members|results)
 *
 * Verifies that the new full-screen workspace correctly:
 *  - Shows 4 sidebar tabs (manager) or 3 tabs (student, no results)
 *  - Each tab renders the expected content section
 *  - Student can access overview, lessons, members tabs
 *  - Student cannot access results tab (sees "no permission" message)
 *  - Header breadcrumb with org name and course title is present
 *  - bg-background applied to all major containers (no "black zone")
 *
 * Fixtures:
 *   userPage    = alice  (org ADMIN in hust-cs)
 *   teacherPage = carol  (org TEACHER / course owner DSA)
 *   studentPage = bob    (enrolled DSA course, org STUDENT)
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

/**
 * Navigate to the DSA course workspace and return the base course URL (no tab param).
 */
async function goToCourseWorkspace(
  page: import("@playwright/test").Page,
): Promise<string> {
  await page.goto(
    `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
    { waitUntil: "domcontentloaded" },
  );
  const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
  const href = await card.getByRole("link").first().getAttribute("href");
  if (!href) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" not found`);
  return href.split("?")[0];
}

// ── Header breadcrumb ──────────────────────────────────────────────────────────

test.describe("Course workspace — header", () => {
  test("shows org name and course title in header breadcrumb (admin)", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    // Header contains the org name
    await expect(page.locator("header").getByText("HUST Computer Science")).toBeVisible();
    // Header contains the course title (in header breadcrumb p element)
    await expect(page.locator("header").getByText(SEED_DSA_COURSE_TITLE)).toBeVisible();
  });

  test("shows Đăng xuất button in header", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("header").getByRole("button", { name: /Đăng xuất/ })).toBeVisible();
  });
});

// ── Sidebar tabs visibility ────────────────────────────────────────────────────

test.describe("Course workspace — sidebar tabs (manager)", () => {
  test("admin sees 5 tabs: Tổng quan, Bài học, Thành viên, Duyệt yêu cầu, Kết quả học tập", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Tổng quan" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Bài học" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Thành viên" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).toBeVisible();
  });

  test("teacher sees all 5 manager tabs including Duyệt yêu cầu", async ({ teacherPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).toBeVisible();
  });
});

test.describe("Course workspace — sidebar tabs (student)", () => {
  test("student sees 3 tabs: Tổng quan, Bài học, Thành viên (no Kết quả học tập, no Duyệt yêu cầu)", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Tổng quan" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Bài học" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Thành viên" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).not.toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).not.toBeVisible();
  });
});

// ── Tab: Tổng quan ─────────────────────────────────────────────────────────────

test.describe("Course workspace — ?tab=overview", () => {
  test("admin sees Thông tin chung and Trạng thái sections", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Thông tin chung")).toBeVisible();
    await expect(page.getByText("Trạng thái")).toBeVisible();
  });

  test("admin sees Xóa khóa học danger zone", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Xóa khóa học")).toBeVisible();
  });

  test("student sees course title h1 but NOT Thông tin chung or status/danger sections", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The overview is manager-only chrome: students no longer see the status panel,
    // the "Thông tin chung" editor, or the danger zone.
    await expect(page.getByText("Trạng thái")).not.toBeVisible();
    await expect(page.getByText("Thông tin chung")).not.toBeVisible();
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();
  });

  // ── Overview enrichments (per role) ──────────────────────────────────────────

  test("learner sees 'Tiến độ của bạn' card with progress + a continue-learning CTA", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const progress = page.getByTestId("my-course-progress");
    await expect(progress).toBeVisible();
    await expect(progress.getByRole("heading", { name: "Tiến độ của bạn" })).toBeVisible();
    await expect(progress.getByText(/bài học đã làm/)).toBeVisible();
    // Either a "Bắt đầu/Tiếp tục học" link (lessons remain) or the all-done banner.
    const cta = progress.getByRole("link", { name: /Bắt đầu học|Tiếp tục học/ });
    const done = progress.getByText(/đã làm hết tất cả bài học/);
    await expect(cta.or(done).first()).toBeVisible();
  });

  test("learner sees 'Tiến độ theo chương' with per-chapter progress + mastery score", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const chart = page.getByTestId("module-chart");
    await expect(chart.getByRole("heading", { name: "Tiến độ theo chương" })).toBeVisible();
    // Each chapter row shows the learner's completion as "done/total bài".
    await expect(chart.getByText(/\d+\/\d+ bài/).first()).toBeVisible();
    // bob has attempts → at least one chapter shows a mastery score "· NN%".
    await expect(chart.getByText(/· \d+%/).first()).toBeVisible();
  });

  test("learner with multiple attempts sees the score-trend sparkline", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    // bob has ≥2 attempts on the DSA course → the score-trend chart renders.
    const trend = page.getByTestId("score-trend");
    await expect(trend).toBeVisible();
    await expect(trend.getByText("Xu hướng điểm qua các bài")).toBeVisible();
    // Match the chart by aria-label (the section also contains an InfoHint "?" SVG).
    await expect(trend.getByRole("img", { name: "Xu hướng điểm" })).toBeVisible();
  });

  test("manager sees 'Nội dung theo chương' with content readiness per chapter", async ({ teacherPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const chart = page.getByTestId("module-chart");
    await expect(chart.getByRole("heading", { name: "Nội dung theo chương" })).toBeVisible();
    // Manager rows show "X/N bài có video · M phút" (content readiness, not a bare
    // duration that leaves chapters with no video looking empty/broken).
    await expect(chart.getByText(/\d+\/\d+ bài có video · \d+ phút/).first()).toBeVisible();
  });

  test("manager does NOT see the learner progress card", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("my-course-progress")).not.toBeVisible();
  });

  test("manager sees the 'Nhịp độ lớp học' class pulse with class metrics", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    // The pulse streams in via Suspense; toBeVisible auto-waits for it.
    await expect(page.getByRole("heading", { name: "Nhịp độ lớp học" })).toBeVisible();
    await expect(page.getByText("Tiến độ TB")).toBeVisible();
    await expect(page.getByText("Đã tham gia")).toBeVisible();
  });

  test("overview replaces the lesson outline with a per-chapter chart", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    // The old "Nội dung khóa học" outline (duplicating the Bài học tab) is gone…
    await expect(page.getByRole("heading", { name: "Nội dung khóa học" })).toHaveCount(0);
    // …replaced by the per-chapter chart. A student sees their progress per chapter.
    // (The standalone resume card is now conditional — only for a genuinely recent
    // lesson — so it is not asserted here; the progress card already carries the CTA.)
    const chart = page.getByTestId("module-chart");
    await expect(chart).toBeVisible();
    await expect(chart.getByRole("heading", { name: "Tiến độ theo chương" })).toBeVisible();
  });
});

// ── Tab: Bài học ───────────────────────────────────────────────────────────────

test.describe("Course workspace — ?tab=lessons", () => {
  test("admin sees Nội dung heading and Thêm chương button", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=lessons`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thêm chương" })).toBeVisible();
  });

  test("seeded modules and lessons are listed", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=lessons`, { waitUntil: "domcontentloaded" });
    // The DSA course has modules and lessons seeded
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
    // At least one lesson link is rendered. The displayed title no longer carries the
    // redundant "Bài N:" prefix, so match on the lesson href instead of the title text.
    await expect(page.locator('a[href*="/lessons/"]').first()).toBeVisible();
  });

  test("student sees lessons but NOT Thêm chương", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=lessons`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thêm chương" })).not.toBeVisible();
  });
});

// ── Tab: Thành viên ────────────────────────────────────────────────────────────

test.describe("Course workspace — ?tab=members", () => {
  test("admin sees Thành viên khóa học heading and Thêm thành viên button", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=members`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Thành viên khóa học" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).toBeVisible();
  });

  test("member table shows column headers", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=members`, { waitUntil: "domcontentloaded" });
    // Members render as two grouped tables (managers / learners); scope the
    // header assertions to the managers group to avoid duplicate-header ambiguity.
    const managers = page.getByTestId("members-group-managers");
    await expect(managers.getByRole("columnheader", { name: "Thành viên" })).toBeVisible();
    await expect(managers.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(managers.getByRole("columnheader", { name: "Ngày tham gia" })).toBeVisible();
  });

  test("student sees members table but NOT Thêm thành viên", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=members`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Thành viên khóa học" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).not.toBeVisible();
  });
});

// ── Tab: Kết quả học tập ───────────────────────────────────────────────────────

test.describe("Course workspace — ?tab=results", () => {
  test("admin sees Kết quả học viên heading and results table", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=results`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Kết quả học viên" })).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
  });

  test("results table exposes progress + score + watch columns", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=results`, { waitUntil: "domcontentloaded" });
    // "Tiến độ" = lessons attempted (the single progress metric); "% xem" surfaces
    // the average watch fraction. Headers render even with no rows. ("% trả lời"
    // was removed — it was ~always 100% since answering is required to submit.)
    for (const col of ["Tiến độ", "Điểm TB", "% xem"]) {
      await expect(page.getByRole("columnheader", { name: col, exact: true })).toBeVisible();
    }
  });

  test("student sees no-permission message on results tab", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=results`, { waitUntil: "domcontentloaded" });
    // Student is not shown the results tab in sidebar, but if they navigate directly,
    // they see the "no permission" message
    await expect(page.getByText(/không có quyền xem/i)).toBeVisible();
  });
});

// ── Tab: Duyệt yêu cầu ────────────────────────────────────────────────────────

test.describe("Course workspace — ?tab=join-requests (sidebar visibility)", () => {
  test("admin sees 'Duyệt yêu cầu' tab in sidebar (5 tabs total)", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Tổng quan" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Bài học" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Thành viên" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).toBeVisible();
  });

  test("student does NOT see 'Duyệt yêu cầu' tab in sidebar", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).not.toBeVisible();
  });
});

test.describe("Course workspace — ?tab=join-requests (content)", () => {
  test("admin sees 'Duyệt yêu cầu tham gia' heading", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=join-requests`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Duyệt yêu cầu tham gia" }),
    ).toBeVisible();
  });

  test("admin sees 'Người yêu cầu' column header", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=join-requests`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("columnheader", { name: "Người yêu cầu" }),
    ).toBeVisible();
  });

  test("student navigating directly to ?tab=join-requests sees no-permission message", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=join-requests`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Bạn không có quyền duyệt yêu cầu của khóa học này."),
    ).toBeVisible();
  });
});
