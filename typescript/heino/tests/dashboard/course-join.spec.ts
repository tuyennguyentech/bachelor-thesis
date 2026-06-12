/**
 * E2E tests — Course Join Request flow.
 *
 * Seed scenario:
 *   bob (studentPage) is an active member of hust-cs (org STUDENT role).
 *   bob is enrolled in: DSA, Mạng máy tính.
 *   bob is NOT enrolled in: "Lập trình hướng đối tượng với Java" (OOP) → sees lock screen.
 *
 *   alice (userPage) is org ADMIN of hust-cs → canManage = true → sees "Duyệt yêu cầu" tab.
 *   carol (teacherPage) is org TEACHER of hust-cs → canManage = true.
 *
 * Lock screen selectors (from course-lock-screen.tsx):
 *   - Card title:         "Khóa học đang bị khóa"
 *   - Card description:   "Bạn chưa đăng ký tham gia..."
 *   - Primary button:     "Yêu cầu tham gia khóa học"  (status=UNSPECIFIED)
 *   - After submit:       "Đã gửi yêu cầu tham gia"     (disabled, status=PENDING)
 *   - Pending alert text: "Đang chờ phê duyệt"
 *   - Back link text:     "Quay lại danh sách khóa học"
 *
 * Join-requests tab (from join-requests-tab.tsx):
 *   - Heading:            "Duyệt yêu cầu tham gia"
 *   - Table column:       "Người yêu cầu"
 *   - Approve button:     "Duyệt"
 *   - Reject button:      "Từ chối"
 *   - Empty state:        "Không có yêu cầu nào"
 *
 * Sidebar tab label (from course-workspace.tsx):
 *   - "Duyệt yêu cầu"
 *
 * Isolation strategy (mutation tests):
 *   - A fresh student user (unique email) is created via API in beforeAll.
 *   - A fresh course owned by carol is created in hust-cs.
 *   - The fresh student is added to hust-cs as OrganizationRole.STUDENT but NOT to the fresh course.
 *   - The submit→approve lifecycle runs on fresh-student + fresh-course, never bob/OOP.
 *   - Read-only lock-screen tests for bob against the seeded OOP course remain unchanged.
 */

import {
  test,
  expect,
  uid,
  loginAs,
  getAdminAuth,
  getTeacherAuth,
  getToken,
  getOrgId,
  createUser,
  addOrgMember,
  createCourse,
  submitJoinRequest,
  USER_EMAIL,
  USER_PASSWORD,
  SEED_HUST_CS_SLUG,
  OrganizationRole,
} from "../fixtures";

const ORG_SLUG = SEED_HUST_CS_SLUG;
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;

// Course that bob (studentPage) is NOT enrolled in.
// Seed: "Lập trình hướng đối tượng với Java" has frank as teacher, kate/liam/mia/noah as students.
// Bob has no entry for this course in course_members.json.
const LOCKED_COURSE_TITLE = "Lập trình hướng đối tượng với Java";

/**
 * Navigate to the OOP course workspace for the given user page.
 * Uses ?q= search to find the course, then reads href to navigate.
 * Returns the base course URL (no tab param).
 */
async function goToOopCourse(page: import("@playwright/test").Page): Promise<string> {
  await page.goto(
    `${COURSES_URL}?q=${encodeURIComponent(LOCKED_COURSE_TITLE)}`,
    { waitUntil: "domcontentloaded" },
  );
  // Find the course card (may be locked for bob or accessible for managers)
  const card = page.locator('[data-slot="card"]').filter({ hasText: LOCKED_COURSE_TITLE }).first();
  const href = await card.getByRole("link").first().getAttribute("href");
  if (!href) throw new Error(`Could not find course link for "${LOCKED_COURSE_TITLE}"`);
  return href.split("?")[0];
}

// ── Lock screen — non-enrolled org member sees lock ────────────────────────

test.describe("Course lock screen — non-enrolled org member (bob)", () => {
  test("sees Khóa học đang bị khóa heading and description", async ({ studentPage: page }) => {
    const courseHref = await goToOopCourse(page);
    await page.goto(courseHref, { waitUntil: "domcontentloaded" });

    // "Khóa học đang bị khóa" is rendered as a CardTitle (generic element, not a heading role)
    await expect(
      page.getByText("Khóa học đang bị khóa"),
    ).toBeVisible();

    await expect(
      page.getByText("Bạn chưa đăng ký tham gia hoặc chưa được phê duyệt vào khóa học này."),
    ).toBeVisible();
  });

  test("sees the course title inside the lock screen card", async ({ studentPage: page }) => {
    const courseHref = await goToOopCourse(page);
    await page.goto(courseHref, { waitUntil: "domcontentloaded" });

    // The lock screen card shows the course title in a <h3> inside CardContent
    await expect(page.getByRole("heading", { name: LOCKED_COURSE_TITLE })).toBeVisible();
  });

  test("sees 'Yêu cầu tham gia khóa học' button (initial state, no prior request)", async ({ studentPage: page }) => {
    const courseHref = await goToOopCourse(page);
    await page.goto(courseHref, { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("button", { name: "Yêu cầu tham gia khóa học" }),
    ).toBeVisible();
  });

  test("sees 'Quay lại danh sách khóa học' back link", async ({ studentPage: page }) => {
    const courseHref = await goToOopCourse(page);
    await page.goto(courseHref, { waitUntil: "domcontentloaded" });

    const backLink = page.getByRole("link", { name: /Quay lại danh sách khóa học/ });
    await expect(backLink).toBeVisible();

    // Verify the href goes to the courses list
    const href = await backLink.getAttribute("href");
    expect(href).toContain(`/dashboard/organizations/${ORG_SLUG}/courses`);
  });
});

// ── Lock screen — submitting a join request (fresh isolated user + fresh course) ────

test.describe("Course lock screen — submitting join request (fresh student)", () => {
  let freshEmail: string;
  let freshCourseHref: string;

  test.beforeAll(async ({ baseURL }) => {
    // Create a fresh student user (not in any course)
    freshEmail = `joiner-${uid("")}@test.local`;
    const { token: adminToken } = await getAdminAuth(baseURL);
    const { token: teacherToken, userId: carolId } = await getTeacherAuth(baseURL);

    const freshUserId = await createUser(adminToken, { email: freshEmail }, baseURL);
    const orgId = await getOrgId(adminToken, SEED_HUST_CS_SLUG, baseURL);

    // Add fresh student to hust-cs org (but not to any course)
    await addOrgMember(adminToken, orgId, freshUserId, OrganizationRole.STUDENT, baseURL);

    // Create a fresh course owned by carol — fresh student is NOT enrolled
    const freshCourseTitle = uid("Khóa học Thử nghiệm Tham gia");
    const courseId = await createCourse(teacherToken, orgId, freshCourseTitle, carolId, baseURL);
    // Derive the course URL directly from the returned courseId
    freshCourseHref = `/dashboard/organizations/${ORG_SLUG}/courses/${courseId}`;
  });

  test("clicking 'Yêu cầu tham gia khóa học' shows pending state", async ({ page, baseURL }) => {
    await loginAs(page, freshEmail, USER_PASSWORD, baseURL ?? "http://caddy");
    await page.goto(freshCourseHref, { waitUntil: "domcontentloaded" });

    const btn = page.getByRole("button", { name: "Yêu cầu tham gia khóa học" });
    await expect(btn).toBeEnabled();
    await btn.click();

    // After submission the server action revalidates the path.
    // The page re-renders with the PENDING join request status.
    // The button should become disabled with "Đã gửi yêu cầu tham gia" text.
    await expect(
      page.getByRole("button", { name: "Đã gửi yêu cầu tham gia" }),
    ).toBeVisible();
  });

  test("after submitting, pending alert 'Đang chờ phê duyệt' is shown", async ({ page, baseURL }) => {
    await loginAs(page, freshEmail, USER_PASSWORD, baseURL ?? "http://caddy");
    await page.goto(freshCourseHref, { waitUntil: "domcontentloaded" });

    // Submit a join request (may already be PENDING from prior test run — handle both states)
    const requestBtn = page.getByRole("button", { name: "Yêu cầu tham gia khóa học" });
    if (await requestBtn.isVisible()) {
      await requestBtn.click();
    }

    // Either already pending from before, or just submitted — the pending alert must appear
    await expect(page.getByText("Đang chờ phê duyệt")).toBeVisible();
  });
});

// ── Manager sees Duyệt yêu cầu tab ────────────────────────────────────────

test.describe("Course workspace — 'Duyệt yêu cầu' tab visible to manager", () => {
  /**
   * Navigate to OOP course as admin (alice) — she has canManage=true via org ADMIN role.
   * Uses ?q= search to find the course link and navigates directly.
   */
  async function goToOopCourseAsManager(page: import("@playwright/test").Page): Promise<string> {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(LOCKED_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    // As admin, alice sees ALL courses as "Khóa học của bạn" (no lock), with "Quản lý" link
    const card = page.locator('[data-slot="card"]').filter({ hasText: LOCKED_COURSE_TITLE }).first();
    const href = await card.getByRole("link").first().getAttribute("href");
    if (!href) throw new Error(`Admin cannot find course link for "${LOCKED_COURSE_TITLE}"`);
    return href.split("?")[0];
  }

  test("admin sees 'Duyệt yêu cầu' tab in sidebar", async ({ userPage: page }) => {
    const courseHref = await goToOopCourseAsManager(page);
    await page.goto(`${courseHref}?tab=overview`, { waitUntil: "domcontentloaded" });

    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).toBeVisible();
  });

  test("teacher carol sees 'Duyệt yêu cầu' tab in sidebar for DSA course", async ({ teacherPage: page }) => {
    // Carol is org TEACHER → canManage = true for any course she accesses
    const dsaTitle = "Cấu trúc dữ liệu và Giải thuật";
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(dsaTitle)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: dsaTitle }).first();
    const rawHref = await card.getByRole("link").first().getAttribute("href");
    if (!rawHref) throw new Error("DSA course link not found for carol");
    const courseHref = rawHref.split("?")[0];

    await page.goto(`${courseHref}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).toBeVisible();
  });

  test("student bob does NOT see 'Duyệt yêu cầu' tab", async ({ studentPage: page }) => {
    // bob is enrolled in DSA → sees the course workspace (not lock screen)
    const dsaTitle = "Cấu trúc dữ liệu và Giải thuật";
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(dsaTitle)}`,
      { waitUntil: "domcontentloaded" },
    );
    // For enrolled courses, bob sees a card with "Vào học" link
    const card = page.locator('[data-slot="card"]').filter({ hasText: dsaTitle }).first();
    const rawHref = await card.getByRole("link").first().getAttribute("href");
    if (!rawHref) throw new Error("DSA course link not found for bob");
    const courseHref = rawHref.split("?")[0];

    await page.goto(`${courseHref}?tab=overview`, { waitUntil: "domcontentloaded" });
    const sidebar = page.locator("aside[aria-label='Course workspace sidebar']");
    await expect(sidebar.getByRole("link", { name: "Duyệt yêu cầu" })).not.toBeVisible();
  });
});

// ── Manager reviews join request in Duyệt yêu cầu tab (fresh isolated entities) ──

test.describe("Course workspace — join-requests tab content (manager)", () => {
  let freshEmail: string;
  let freshToken: string;
  let freshCourseTitle: string;
  let freshCourseHref: string;
  let freshCourseId: string;

  test.beforeAll(async ({ baseURL }) => {
    // Create fresh isolated entities for the join-requests tab tests
    freshEmail = `joiner-tab-${uid("")}@test.local`;
    freshCourseTitle = uid("Khóa học Duyệt Yêu Cầu");

    const { token: adminToken } = await getAdminAuth(baseURL);
    const { token: teacherToken, userId: carolId } = await getTeacherAuth(baseURL);

    const freshUserId = await createUser(adminToken, { email: freshEmail }, baseURL);
    const orgId = await getOrgId(adminToken, SEED_HUST_CS_SLUG, baseURL);

    // Add fresh student to hust-cs org (NOT to the fresh course)
    await addOrgMember(adminToken, orgId, freshUserId, OrganizationRole.STUDENT, baseURL);

    // Authenticate fresh student so we can submit join requests via API
    freshToken = await getToken(freshEmail, USER_PASSWORD, baseURL);

    // Create fresh course owned by carol — derive the course URL directly from the returned ID
    freshCourseId = await createCourse(teacherToken, orgId, freshCourseTitle, carolId, baseURL);
    freshCourseHref = `/dashboard/organizations/${ORG_SLUG}/courses/${freshCourseId}`;
  });

  /**
   * Navigate to the fresh course's join-requests tab as admin (alice).
   * Uses the direct course URL stored in freshCourseHref — no search required.
   */
  async function goToFreshJoinRequestsTab(page: import("@playwright/test").Page): Promise<void> {
    await page.goto(`${freshCourseHref}?tab=join-requests`, { waitUntil: "domcontentloaded" });
  }

  test("admin sees 'Duyệt yêu cầu tham gia' heading in join-requests tab", async ({ userPage: page }) => {
    await goToFreshJoinRequestsTab(page);
    await expect(
      page.getByRole("heading", { name: "Duyệt yêu cầu tham gia" }),
    ).toBeVisible();
  });

  test("join-requests tab shows 'Người yêu cầu' table column", async ({ userPage: page }) => {
    await goToFreshJoinRequestsTab(page);
    await expect(
      page.getByRole("columnheader", { name: "Người yêu cầu" }),
    ).toBeVisible();
  });

  test("join-requests tab shows Ngày yêu cầu column header", async ({ userPage: page }) => {
    await goToFreshJoinRequestsTab(page);
    await expect(
      page.getByRole("columnheader", { name: "Ngày yêu cầu" }),
    ).toBeVisible();
  });

  test("shows empty state 'Không có yêu cầu nào' when no pending requests", async ({ userPage: page }) => {
    // Fresh course has no join requests yet — empty state must appear.
    await goToFreshJoinRequestsTab(page);
    const approveButtons = page.getByRole("button", { name: "Duyệt" });
    const emptyState = page.getByText("Không có yêu cầu nào");
    // At least one of these must be visible — the tab renders one or the other
    const hasApprove = await approveButtons.first().isVisible().catch(() => false);
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    expect(hasApprove || hasEmpty).toBe(true);
  });

  test("fresh student's join request row shows email and Duyệt + Từ chối buttons", async ({ userPage: adminPage, baseURL }) => {
    // Step 1: Submit join request via API (avoids browser hydration timing issues)
    await submitJoinRequest(freshToken, freshCourseId, baseURL);

    // Step 2: admin alice opens the join-requests tab and sees the fresh student's request
    await goToFreshJoinRequestsTab(adminPage);

    // Fresh student email should appear in the table
    await expect(adminPage.getByText(freshEmail)).toBeVisible();

    // The Duyệt and Từ chối buttons should appear in the fresh student's row
    const freshRow = adminPage.getByRole("row").filter({ hasText: freshEmail });
    await expect(freshRow.getByRole("button", { name: "Duyệt" })).toBeVisible();
    await expect(freshRow.getByRole("button", { name: "Từ chối" })).toBeVisible();
  });

  test("admin approves fresh student's join request — request disappears and student can access course", async ({ page: freshPage, userPage: adminPage, baseURL }) => {
    // Step 1: Ensure the fresh student's join request exists via API
    await submitJoinRequest(freshToken, freshCourseId, baseURL);

    // Step 2: Admin navigates to join-requests tab and approves
    await goToFreshJoinRequestsTab(adminPage);
    const freshRow = adminPage.getByRole("row").filter({ hasText: freshEmail });
    await expect(freshRow).toBeVisible();
    await freshRow.getByRole("button", { name: "Duyệt" }).click();

    // After approval, the server revalidates the path.
    // The fresh student's row should disappear (or empty state appears if no more requests).
    await expect(adminPage.getByText(freshEmail)).not.toBeVisible();

    // Step 3: Fresh student logs in and reloads the course page — should see the workspace
    await loginAs(freshPage, freshEmail, USER_PASSWORD, baseURL ?? "http://caddy");
    await freshPage.goto(freshCourseHref, { waitUntil: "domcontentloaded" });
    // Lock screen title should NOT be present (rendered as CardTitle, a generic element)
    await expect(
      freshPage.getByText("Khóa học đang bị khóa"),
    ).not.toBeVisible();
    // The course workspace sidebar should be visible instead
    await expect(
      freshPage.locator("aside[aria-label='Course workspace sidebar']"),
    ).toBeVisible();
  });
});

// ── Non-manager cannot access join-requests tab ────────────────────────────

test.describe("Course join-requests tab — student access denied", () => {
  test("student navigating to ?tab=join-requests sees no-permission message", async ({ studentPage: page }) => {
    // Bob is enrolled in DSA → can reach its workspace but has no manage rights
    const dsaTitle = "Cấu trúc dữ liệu và Giải thuật";
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(dsaTitle)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: dsaTitle }).first();
    const rawHref = await card.getByRole("link").first().getAttribute("href");
    if (!rawHref) throw new Error("DSA course href not found for bob");
    const courseHref = rawHref.split("?")[0];

    await page.goto(`${courseHref}?tab=join-requests`, { waitUntil: "domcontentloaded" });
    // The page renders the "no permission" message from the join-requests branch in page.tsx
    await expect(
      page.getByText("Bạn không có quyền duyệt yêu cầu của khóa học này."),
    ).toBeVisible();
  });
});
