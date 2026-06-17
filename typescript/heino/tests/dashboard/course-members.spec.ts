/**
 * E2E tests — Course members tab (?tab=members) for the seeded DSA course in hust-cs.
 *
 * Seed roles:
 *   alice  (userPage)    = org ADMIN  → canManage = true  → sees Thêm thành viên button
 *   carol  (teacherPage) = org TEACHER → canManage = true  → also sees Thêm thành viên button
 *   bob    (studentPage) = course STUDENT, org STUDENT role → does NOT see Thêm thành viên
 *
 * Navigation: /dashboard/organizations/hust-cs/courses/<courseId>?tab=members
 * (Course workspace — tab-based navigation, no longer a separate /members page.)
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

/**
 * Navigate to the DSA course members tab (?tab=members) and return the URL.
 * Constructs the workspace URL directly from the course href found in the courses list.
 */
async function goToCourseMembersPage(page: import("@playwright/test").Page): Promise<string> {
  // Navigate to courses list via ?q= search to find the seeded DSA course
  await page.goto(`${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, {
    waitUntil: "domcontentloaded",
  });
  const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
  const courseHref = await card.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" not found in course list`);

  // Navigate to the members tab of the course workspace
  const membersUrl = courseHref.split("?")[0].replace(/\/$/, "") + "?tab=members";
  await page.goto(membersUrl, { waitUntil: "domcontentloaded" });
  return page.url();
}

// ── Members table content ──────────────────────────────────────────────────

test.describe("Course members page — table content (manager view)", () => {
  test("shows Thành viên khóa học heading", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    await expect(page.getByRole("heading", { name: "Thành viên khóa học" })).toBeVisible();
  });

  test("shows the two member groups (Quản lý / Thành viên)", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    // Members are split into a managers group and a learners group, each a
    // labelled table. Scope to the group testids to avoid the two identical
    // column-header sets clashing under strict mode.
    const managers = page.getByTestId("members-group-managers");
    const learners = page.getByTestId("members-group-learners");
    await expect(managers).toBeVisible();
    await expect(learners).toBeVisible();
    await expect(managers.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(managers.getByRole("columnheader", { name: "Ngày tham gia" })).toBeVisible();
  });

  test("bob appears in the learners group as Thành viên", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    const learners = page.getByTestId("members-group-learners");
    // Bob (course STUDENT) is a learner; his email is shown under his name.
    await expect(learners.getByText("bob@dyadia.local")).toBeVisible();
    // His role badge reads "Thành viên" (exact — the row's actions-menu sr-only
    // label "Mở menu thao tác thành viên" also contains the substring).
    const bobRow = learners.getByRole("row").filter({ hasText: "bob@dyadia.local" });
    await expect(bobRow.getByText("Thành viên", { exact: true })).toBeVisible();
  });

  test("carol (course owner) appears in the managers group as Chủ khóa học", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    const managers = page.getByTestId("members-group-managers");
    await expect(managers.getByText("carol@dyadia.local")).toBeVisible();
    // Carol owns the DSA course, so her badge is the owner badge, not "Quản lý".
    const carolRow = managers.getByRole("row").filter({ hasText: "carol@dyadia.local" });
    await expect(carolRow.getByText("Chủ khóa học")).toBeVisible();
  });
});

// ── Manager sees Thêm thành viên ───────────────────────────────────────────

test.describe("Course members page — add member button (manager)", () => {
  test("org admin sees Thêm thành viên button", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).toBeVisible();
  });

  test("clicking Thêm thành viên opens dialog with Email field", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    await page.getByRole("button", { name: "Thêm thành viên" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Thêm thành viên khóa học" })).toBeVisible();
    // The form has an Email label/input
    await expect(page.getByLabel("Email")).toBeVisible();
    // And a Vai trò select — scope to the dialog label element (not the table <th> or description)
    await expect(page.getByRole("dialog").locator("label").filter({ hasText: "Vai trò" })).toBeVisible();
    // And Add / Cancel buttons
    await expect(page.getByRole("dialog").getByRole("button", { name: "Thêm" })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Hủy" })).toBeVisible();
  });

  test("teacher also sees Thêm thành viên button (canManage=true)", async ({ teacherPage: page }) => {
    await goToCourseMembersPage(page);
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).toBeVisible();
  });
});

// ── Student does NOT see Thêm thành viên ─────────────────────────────────

test.describe("Course members page — student access", () => {
  test("student reaches members page but does NOT see Thêm thành viên button", async ({ studentPage: page }) => {
    // Bob is an org member (STUDENT role), so requireOrgMember passes, but effectiveCanManage=false
    await goToCourseMembersPage(page);
    // The page loads successfully (heading visible)
    await expect(page.getByRole("heading", { name: "Thành viên khóa học" })).toBeVisible();
    // No management controls
    await expect(page.getByRole("button", { name: "Thêm thành viên" })).not.toBeVisible();
    // The member groups still render (read-only); learners group is visible.
    await expect(page.getByTestId("members-group-learners")).toBeVisible();
  });
});

// ── Full add-member lifecycle (manager proactively adds, then removes) ───────

test.describe("Course members page — add member lifecycle (manager)", () => {
  // A manager PROACTIVELY adds a member (not just approving join requests). alice
  // (org admin) adds noah — a hust-cs member NOT in DSA — as a learner, confirms he
  // appears, then removes him so the shared seed stays clean for retries/parallel runs.
  const NEW_MEMBER_EMAIL = "noah@dyadia.local";

  test("add by email → noah appears as Thành viên → remove for cleanup", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    const learners = page.getByTestId("members-group-learners");
    // Precondition: noah is not already a DSA member.
    await expect(learners.getByText(NEW_MEMBER_EMAIL)).toHaveCount(0);

    let added = false;
    try {
      // Open the proactive add dialog and add noah (default role = Học viên).
      await page.getByRole("button", { name: "Thêm thành viên" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Email").fill(NEW_MEMBER_EMAIL);
      await dialog.getByRole("button", { name: "Thêm" }).click();
      // Dialog closes; the table refreshes (router.refresh) with noah present.
      await expect(dialog).not.toBeVisible({ timeout: 15000 });
      await expect(learners.getByText(NEW_MEMBER_EMAIL)).toBeVisible({ timeout: 15000 });
      added = true;
      const noahRow = learners.getByRole("row").filter({ hasText: NEW_MEMBER_EMAIL });
      await expect(noahRow.getByText("Thành viên", { exact: true })).toBeVisible();
    } finally {
      // Cleanup: remove noah via his row actions menu.
      if (added) {
        const noahRow = learners.getByRole("row").filter({ hasText: NEW_MEMBER_EMAIL });
        if (await noahRow.count()) {
          await noahRow.getByRole("button", { name: "Mở menu thao tác thành viên" }).click();
          await page.getByRole("menuitem", { name: "Xóa khỏi khóa học" }).click();
          await page.getByRole("button", { name: "Xóa", exact: true }).click();
          await expect(learners.getByText(NEW_MEMBER_EMAIL)).not.toBeVisible({ timeout: 10000 });
        }
      }
    }
  });
});
