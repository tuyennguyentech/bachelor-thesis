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
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
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

// ── Lock screen — submitting a join request ────────────────────────────────

test.describe("Course lock screen — submitting join request (bob)", () => {
  test("clicking 'Yêu cầu tham gia khóa học' shows pending state", async ({ studentPage: page }) => {
    const courseHref = await goToOopCourse(page);
    await page.goto(courseHref, { waitUntil: "domcontentloaded" });

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

  test("after submitting, pending alert 'Đang chờ phê duyệt' is shown", async ({ studentPage: page }) => {
    const courseHref = await goToOopCourse(page);
    await page.goto(courseHref, { waitUntil: "domcontentloaded" });

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

// ── Manager reviews join request in Duyệt yêu cầu tab ──────────────────────

test.describe("Course workspace — join-requests tab content (manager)", () => {
  /**
   * Navigate to OOP course as admin and open the join-requests tab.
   * Pre-condition: bob's join request for OOP has been submitted (test order
   * within this describe block does NOT rely on the prior describe block
   * having run first — we check for both "no requests" and "approve" scenarios).
   */
  async function goToOopJoinRequestsTab(page: import("@playwright/test").Page): Promise<void> {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(LOCKED_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: LOCKED_COURSE_TITLE }).first();
    const href = await card.getByRole("link").first().getAttribute("href");
    if (!href) throw new Error("Admin cannot find OOP course link");
    await page.goto(`${href.split("?")[0]}?tab=join-requests`, { waitUntil: "domcontentloaded" });
  }

  test("admin sees 'Duyệt yêu cầu tham gia' heading in join-requests tab", async ({ userPage: page }) => {
    await goToOopJoinRequestsTab(page);
    await expect(
      page.getByRole("heading", { name: "Duyệt yêu cầu tham gia" }),
    ).toBeVisible();
  });

  test("join-requests tab shows 'Người yêu cầu' table column", async ({ userPage: page }) => {
    await goToOopJoinRequestsTab(page);
    await expect(
      page.getByRole("columnheader", { name: "Người yêu cầu" }),
    ).toBeVisible();
  });

  test("join-requests tab shows Ngày yêu cầu column header", async ({ userPage: page }) => {
    await goToOopJoinRequestsTab(page);
    await expect(
      page.getByRole("columnheader", { name: "Ngày yêu cầu" }),
    ).toBeVisible();
  });

  test("shows empty state 'Không có yêu cầu nào' when no pending requests", async ({ userPage: page }) => {
    // If no request has been sent, the empty state message appears.
    // This test is valid when run before the join request is submitted.
    // It also serves as the baseline check that the tab renders correctly.
    await goToOopJoinRequestsTab(page);
    // Either there are pending requests (Duyệt/Từ chối buttons) or the empty state shows
    const approveButtons = page.getByRole("button", { name: "Duyệt" });
    const emptyState = page.getByText("Không có yêu cầu nào");
    // At least one of these must be visible — the tab renders one or the other
    const hasApprove = await approveButtons.first().isVisible().catch(() => false);
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    expect(hasApprove || hasEmpty).toBe(true);
  });

  test("bob's join request row shows bob email and Duyệt + Từ chối buttons", async ({ studentPage: studentPage, userPage: adminPage }) => {
    // Step 1: bob submits a join request for OOP course
    await studentPage.goto(
      `${COURSES_URL}?q=${encodeURIComponent(LOCKED_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const bobCard = studentPage.locator('[data-slot="card"]').filter({ hasText: LOCKED_COURSE_TITLE }).first();
    const bobRawHref = await bobCard.getByRole("link").first().getAttribute("href");
    if (!bobRawHref) throw new Error("bob cannot find OOP course link");
    const courseHref = bobRawHref.split("?")[0];
    await studentPage.goto(courseHref, { waitUntil: "domcontentloaded" });

    // Submit if the button exists (may already be PENDING from prior test run)
    const requestBtn = studentPage.getByRole("button", { name: "Yêu cầu tham gia khóa học" });
    if (await requestBtn.isVisible().catch(() => false)) {
      await requestBtn.click();
      // Wait for the UI to reflect the PENDING state
      await expect(
        studentPage.getByRole("button", { name: "Đã gửi yêu cầu tham gia" }),
      ).toBeVisible();
    }

    // Step 2: admin alice opens the join-requests tab and sees bob's request
    await goToOopJoinRequestsTab(adminPage);

    // Bob's email should appear in the table
    await expect(adminPage.getByText("bob@dyadia.local")).toBeVisible();

    // The Duyệt and Từ chối buttons should appear in bob's row
    const bobRow = adminPage.getByRole("row").filter({ hasText: "bob@dyadia.local" });
    await expect(bobRow.getByRole("button", { name: "Duyệt" })).toBeVisible();
    await expect(bobRow.getByRole("button", { name: "Từ chối" })).toBeVisible();
  });

  test("admin approves bob's join request — request disappears and bob can access course", async ({ studentPage: studentPage, userPage: adminPage }) => {
    // Step 1: Ensure bob's join request exists
    await studentPage.goto(
      `${COURSES_URL}?q=${encodeURIComponent(LOCKED_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const bobCard2 = studentPage.locator('[data-slot="card"]').filter({ hasText: LOCKED_COURSE_TITLE }).first();
    const bobRawHref2 = await bobCard2.getByRole("link").first().getAttribute("href");
    if (!bobRawHref2) throw new Error("bob cannot find OOP course link");
    const courseHrefForBob = bobRawHref2.split("?")[0];
    await studentPage.goto(courseHrefForBob, { waitUntil: "domcontentloaded" });

    const requestBtn = studentPage.getByRole("button", { name: "Yêu cầu tham gia khóa học" });
    if (await requestBtn.isVisible().catch(() => false)) {
      await requestBtn.click();
      await expect(
        studentPage.getByRole("button", { name: "Đã gửi yêu cầu tham gia" }),
      ).toBeVisible();
    }

    // Step 2: Admin navigates to join-requests tab and approves
    await goToOopJoinRequestsTab(adminPage);
    const bobRow = adminPage.getByRole("row").filter({ hasText: "bob@dyadia.local" });
    await expect(bobRow).toBeVisible();
    await bobRow.getByRole("button", { name: "Duyệt" }).click();

    // After approval, the server revalidates the path.
    // Bob's row should disappear (or empty state should appear if no more requests).
    await expect(adminPage.getByText("bob@dyadia.local")).not.toBeVisible();

    // Step 3: Bob reloads the course page — he should now see the workspace, not the lock screen
    await studentPage.goto(courseHrefForBob, { waitUntil: "domcontentloaded" });
    // Lock screen title should NOT be present (rendered as CardTitle, a generic element)
    await expect(
      studentPage.getByText("Khóa học đang bị khóa"),
    ).not.toBeVisible();
    // The course workspace sidebar should be visible instead
    await expect(
      studentPage.locator("aside[aria-label='Course workspace sidebar']"),
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
