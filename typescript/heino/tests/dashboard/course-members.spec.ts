/**
 * E2E tests — Course members page for the seeded DSA course in hust-cs.
 *
 * Seed roles:
 *   alice  (userPage)    = org ADMIN  → canManage = true  → sees Thêm thành viên button
 *   carol  (teacherPage) = org TEACHER → canManage = true  → also sees Thêm thành viên button
 *   bob    (studentPage) = course STUDENT, org STUDENT role → does NOT see Thêm thành viên
 *
 * Navigation: /dashboard/organizations/hust-cs/courses/<courseId>/members
 * We reach the page by clicking through the course detail link "Thành viên".
 */

import {
  test,
  expect,
  goToSeededLesson,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

/**
 * Navigate to the DSA course members page and return the URL.
 * Constructs the /members URL directly from the course href to avoid
 * accidentally following the sidebar "Thành viên" org-members link.
 */
async function goToCourseMembersPage(page: import("@playwright/test").Page): Promise<string> {
  // Navigate to the DSA course detail page via ?q= search
  await page.goto(`${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, {
    waitUntil: "domcontentloaded",
  });
  const row = page.getByRole("row").filter({ hasText: SEED_DSA_COURSE_TITLE });
  const courseHref = await row.getByRole("link").first().getAttribute("href");
  if (!courseHref) throw new Error(`Course "${SEED_DSA_COURSE_TITLE}" not found in course list`);

  // Construct the course members URL directly from the course href to avoid
  // picking up the sidebar "Thành viên" org-members nav link.
  const membersUrl = courseHref.replace(/\/$/, "") + "/members";
  await page.goto(membersUrl, { waitUntil: "domcontentloaded" });
  return page.url();
}

// ── Members table content ──────────────────────────────────────────────────

test.describe("Course members page — table content (manager view)", () => {
  test("shows Thành viên khóa học heading", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    await expect(page.getByRole("heading", { name: "Thành viên khóa học" })).toBeVisible();
  });

  test("shows table column headers", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    await expect(page.getByRole("columnheader", { name: "Thành viên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Ngày tham gia" })).toBeVisible();
  });

  test("bob appears in members table as Học viên", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    // Bob's email is shown under his name in the table cell
    await expect(page.getByRole("table").getByText("bob@dyadia.local")).toBeVisible();
    // His role badge reads "Học viên"
    const bobRow = page.getByRole("row").filter({ hasText: "bob@dyadia.local" });
    await expect(bobRow.getByText("Học viên")).toBeVisible();
  });

  test("carol appears in members table as Giảng viên", async ({ userPage: page }) => {
    await goToCourseMembersPage(page);
    await expect(page.getByRole("table").getByText("carol@dyadia.local")).toBeVisible();
    const carolRow = page.getByRole("row").filter({ hasText: "carol@dyadia.local" });
    await expect(carolRow.getByText("Giảng viên")).toBeVisible();
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
    // No actions column (4th column header is empty and only shown for managers)
    // The table still shows members
    await expect(page.getByRole("table")).toBeVisible();
  });
});
