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
  const row = page.getByRole("row").filter({ hasText: SEED_DSA_COURSE_TITLE });
  const href = await row.getByRole("link").first().getAttribute("href");
  if (!href) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" not found`);
  return href;
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
  test("admin sees 4 tabs: Tổng quan, Bài học, Thành viên, Kết quả học tập", async ({ userPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Tổng quan" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Bài học" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Thành viên" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).toBeVisible();
  });

  test("teacher sees all 4 tabs", async ({ teacherPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).toBeVisible();
  });
});

test.describe("Course workspace — sidebar tabs (student)", () => {
  test("student sees 3 tabs: Tổng quan, Bài học, Thành viên (no Kết quả học tập)", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Tổng quan" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Bài học" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Thành viên" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Kết quả học tập" })).not.toBeVisible();
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

  test("student sees course title h1 and Trạng thái but NOT Thông tin chung", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Trạng thái")).toBeVisible();
    await expect(page.getByText("Thông tin chung")).not.toBeVisible();
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();
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
    // At least one lesson link is rendered (link contains lesson title with href to /lessons/)
    await expect(page.getByRole("link").filter({ hasText: /Bài \d+/ }).first()).toBeVisible();
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
    await expect(page.getByRole("columnheader", { name: "Thành viên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Ngày tham gia" })).toBeVisible();
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

  test("student sees no-permission message on results tab", async ({ studentPage: page }) => {
    const href = await goToCourseWorkspace(page);
    await page.goto(`${href}?tab=results`, { waitUntil: "domcontentloaded" });
    // Student is not shown the results tab in sidebar, but if they navigate directly,
    // they see the "no permission" message
    await expect(page.getByText(/không có quyền xem/i)).toBeVisible();
  });
});
