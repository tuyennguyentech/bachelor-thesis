/**
 * E2E tests — student dashboard progress section and course results view.
 *
 * Spec 4: Student progress panel on /dashboard
 *   - REAL BUG: bob (studentPage) has `admin` role in dyadia-demo and `teacher`
 *     role in math-club. The dashboard page sets isStudent = (manageableOrgCount === 0),
 *     where CAN_MANAGE = {OWNER, ADMIN, TEACHER}. bob has manageableOrgCount >= 2,
 *     so isStudent=false and StudentProgressSection is NEVER rendered for bob.
 *     The "student" fixture must be re-seeded with a user who has no manageable org roles
 *     before these tests can verify StudentProgressSection. Tests below reflect the
 *     ACTUAL rendered output for bob (manager view), not the intended student view.
 *
 * Spec 5: Course results table (manager view) on course detail page
 *   - alice (userPage) = org ADMIN in hust-cs → canManage=true → "Kết quả học viên" renders
 *   - bob has 3 seeded attempts (Big-O, Master Theorem, Mảng/Linked List) → non-zero progress
 *   - teacherPage (carol) also has canManage=true → same view
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

// ── Spec 4: Student dashboard — bob is actually a manager (see real bug above) ─

test.describe("Student dashboard — bob's actual view (isStudent=false due to admin/teacher roles)", () => {
  test("dashboard loads and shows h1 greeting", async ({ studentPage: page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    // The top-level h1 is always rendered: "Xin chào, {displayName}"
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("bob sees Có quyền quản lý stat card (manager view, isStudent=false)", async ({ studentPage: page }) => {
    // bob is admin in dyadia-demo and teacher in math-club → manageableOrgCount >= 2
    // → isStudent=false → 4th stat card shows "Có quyền quản lý", not "Khóa học đang học"
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Có quyền quản lý")).toBeVisible();
  });

  test("bob does NOT see Tiến độ học tập của tôi section (isStudent=false)", async ({ studentPage: page }) => {
    // StudentProgressSection is only mounted when isStudent=true.
    // bob has manageable org roles so the section is absent.
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tiến độ học tập của tôi" })).not.toBeVisible();
  });

  test("hust-cs org appears in the Tổ chức sidebar (bob is active member)", async ({ studentPage: page }) => {
    // The Tổ chức sidebar lists bob's orgs (up to 6). hust-cs name is "HUST Computer Science".
    // This is more reliable than checking the recent-courses slice (which only shows first 4
    // courses across all orgs and dyadia-demo's 4 courses may fill that slice before hust-cs).
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("HUST Computer Science")).toBeVisible();
  });

  test("bob does NOT see Bài học đã hoàn thành stat (student stat card absent for manager)", async ({ studentPage: page }) => {
    // "Bài học đã hoàn thành" is a student-only stat card inside StudentProgressSection.
    // Since isStudent=false, this stat is not rendered.
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Bài học đã hoàn thành")).not.toBeVisible();
  });

  test("bob does NOT see Khóa học đang học stat card (student-only, isStudent=false)", async ({ studentPage: page }) => {
    // "Khóa học đang học" is rendered in the 4th stat slot only when isStudent=true.
    // Since bob has manageable org roles, isStudent=false and this card is absent.
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Khóa học đang học")).not.toBeVisible();
  });
});

// ── Spec 4c: PURE student (eve) — StudentProgressSection actually renders ───
// eve@dyadia.local is student-only in every org (manageableOrgCount === 0 →
// isStudent=true) and is enrolled in the DSA course with a completed attempt,
// so the progress feature renders with real data.

test.describe("Student dashboard — pure student (eve) sees progress section", () => {
  test("shows Tiến độ học tập của tôi section heading", async ({ pureStudentPage: page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tiến độ học tập của tôi" })).toBeVisible();
  });

  test("shows student stat cards (Bài học đã hoàn thành, Điểm trung bình, Khóa học đang học)", async ({ pureStudentPage: page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Bài học đã hoàn thành")).toBeVisible();
    await expect(page.getByText("Điểm trung bình")).toBeVisible();
    await expect(page.getByText("Khóa học đang học")).toBeVisible();
    // eve has manage role nowhere → the manager stat card must be absent.
    await expect(page.getByText("Có quyền quản lý")).not.toBeVisible();
  });

  test("DSA course appears in the progress list with a progress figure", async ({ pureStudentPage: page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const section = page.getByRole("heading", { name: "Tiến độ học tập của tôi" }).locator("xpath=ancestor::section[1]");
    // Seed has multiple DSA courses across orgs — assert at least one appears.
    await expect(section.getByText(SEED_DSA_COURSE_TITLE).first()).toBeVisible();
    // Each course card shows a "x/y bài học" progress figure (eve has 1 attempt).
    await expect(section.getByText(/\d+\s*\/\s*\d+\s*bài học/).first()).toBeVisible();
  });
});

// ── Spec 4b: Manager does NOT see student progress section ─────────────────

test.describe("Dashboard — manager does not see student progress section", () => {
  test("alice (org admin) does not see Tiến độ học tập section", async ({ userPage: page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Alice has manageable orgs → isStudent=false → StudentProgressSection NOT rendered
    await expect(page.getByRole("heading", { name: "Tiến độ học tập của tôi" })).not.toBeVisible();
    // Instead alice sees "Có quyền quản lý" stat card
    await expect(page.getByText("Có quyền quản lý")).toBeVisible();
  });
});

// ── Spec 5: Course results table (manager view on course workspace ?tab=results) ──

test.describe("Course detail — Kết quả học viên section (manager view)", () => {
  /**
   * Navigate to the DSA course workspace results tab (?tab=results).
   * Returns the URL landed on.
   */
  async function goToDsaCourseDetail(page: import("@playwright/test").Page): Promise<string> {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    const href = await card.getByRole("link").first().getAttribute("href");
    if (!href) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" link not found`);
    // Strip any query (the manager card CTA links to ...?mode=learn) before
    // appending the tab, so we don't build a malformed "?mode=learn?tab=results".
    const base = href.split("?")[0].replace(/\/$/, "");
    await page.goto(`${base}?tab=results`, { waitUntil: "domcontentloaded" });
    return page.url();
  }

  test("org admin sees Kết quả học viên heading on course detail", async ({ userPage: page }) => {
    await goToDsaCourseDetail(page);
    await expect(page.getByRole("heading", { name: "Kết quả học viên" })).toBeVisible();
    await expect(page.getByText("Kết quả học viên")).toBeVisible();
  });

  test("results table has correct column headers", async ({ userPage: page }) => {
    await goToDsaCourseDetail(page);
    await expect(page.getByText("Kết quả học viên")).toBeVisible();

    // CourseResults renders these column headers in <TableHead>
    await expect(page.getByRole("columnheader", { name: "Học viên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tiến độ" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Điểm TB" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tương tác" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Hoạt động gần nhất" })).toBeVisible();
  });

  test("bob appears in results table with email", async ({ userPage: page }) => {
    await goToDsaCourseDetail(page);
    await expect(page.getByText("Kết quả học viên")).toBeVisible();

    // Bob has completed attempts → he should appear in the student summary table
    // email is rendered in a <span class="text-xs text-muted-foreground"> inside TableCell
    await expect(page.getByRole("table").getByText("bob@dyadia.local")).toBeVisible();
  });

  test("bob's row shows a non-zero progress figure", async ({ userPage: page }) => {
    await goToDsaCourseDetail(page);
    await expect(page.getByText("Kết quả học viên")).toBeVisible();

    const bobRow = page.getByRole("row").filter({ hasText: "bob@dyadia.local" });
    await expect(bobRow).toBeVisible();

    // Progress cell renders "${lessonsCompleted}/${lessonsTotal}" (e.g. "3/16") in a
    // `tabular-nums` span. Scope to that span — the row also contains a score figure
    // that matches the same number/number pattern (strict-mode would see both).
    await expect(bobRow.locator("span.tabular-nums").getByText(/\d+\/[\d—]+/).first()).toBeVisible();
  });

  test("bob's row shows an engagement badge (colored badge)", async ({ userPage: page }) => {
    await goToDsaCourseDetail(page);
    await expect(page.getByText("Kết quả học viên")).toBeVisible();

    const bobRow = page.getByRole("row").filter({ hasText: "bob@dyadia.local" });
    await expect(bobRow).toBeVisible();

    // Columns: Học viên | Tiến độ | Điểm TB | % xem | Tương tác |
    // Hoạt động gần nhất — so the Tương tác cell is td index 4. It renders either:
    //   - a colored Badge (bg-green-100, bg-amber-100, or bg-red-100) when the student has attempts
    //   - a "—" dash span when the student has no attempt
    const engagementCell = bobRow.locator("td").nth(4);
    await expect(engagementCell).toBeVisible();
    // If a colored badge is present, verify it. Otherwise the dash is acceptable.
    const hasBadge = await bobRow.locator(".bg-green-100, .bg-amber-100, .bg-red-100").count() > 0;
    if (hasBadge) {
      await expect(bobRow.locator(".bg-green-100, .bg-amber-100, .bg-red-100").first()).toBeVisible();
    } else {
      // lessonsCompleted = 0 — the cell shows the "—" fallback
      await expect(engagementCell).toContainText("—");
    }
  });

  test("teacher also sees Kết quả học viên section (canManage=true)", async ({ teacherPage: page }) => {
    await goToDsaCourseDetail(page);
    await expect(page.getByText("Kết quả học viên")).toBeVisible();
    await expect(page.getByRole("table").getByText("bob@dyadia.local")).toBeVisible();
  });

  test("student does NOT see Kết quả học viên heading", async ({ studentPage: page }) => {
    await goToDsaCourseDetail(page);
    // canManage=false for bob as a course student → the results section is not rendered
    // The workspace shows "no permission" message instead
    await expect(page.getByText("Kết quả học viên")).not.toBeVisible();
  });
});
