/**
 * E2E tests — course list lock indicator and access control.
 *
 * The courses list page (/dashboard/organizations/hust-cs/courses) shows:
 *   - enrolled courses: no lock icon, chevron-right link is active
 *   - non-enrolled courses: LockIcon + Badge "Chưa tham gia", chevron button disabled
 *
 * Bob (studentPage) is enrolled in "Cấu trúc dữ liệu và Giải thuật" (DSA)
 * but NOT enrolled in at least one other hust-cs course.
 *
 * Alice (userPage) is org ADMIN so `canManage=true` → she sees no locks.
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

// ── Student sees enrolled course as accessible ─────────────────────────────

test.describe("Course list — enrolled course (studentPage = bob)", () => {
  test("enrolled DSA course row is not dimmed and has no lock badge", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByRole("heading", { name: "Khóa học" })).toBeVisible();

    const dsaRow = page.getByRole("row").filter({ hasText: SEED_DSA_COURSE_TITLE });
    await expect(dsaRow).toBeVisible();

    // Row must NOT carry the "Chưa tham gia" badge
    await expect(dsaRow.getByText("Chưa tham gia")).not.toBeVisible();

    // The navigation chevron-right link must be enabled (wrapped in <Link>, not disabled button)
    const chevronLink = dsaRow.getByRole("link");
    await expect(chevronLink).toBeVisible();
    const href = await chevronLink.getAttribute("href");
    expect(href).toMatch(/\/courses\//);
  });

  test("clicking the DSA course row navigates to course detail", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const dsaRow = page.getByRole("row").filter({ hasText: SEED_DSA_COURSE_TITLE });
    const courseHref = await dsaRow.getByRole("link").first().getAttribute("href");
    await page.goto(courseHref!, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: SEED_DSA_COURSE_TITLE })).toBeVisible();
  });
});

// ── Student sees locked course indicator ──────────────────────────────────

test.describe("Course list — locked course indicator (studentPage = bob)", () => {
  test("at least one course shows Chưa tham gia badge", async ({ studentPage: page }) => {
    // Load all courses in hust-cs (no search filter — show everything)
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học" })).toBeVisible();

    // At least one row should carry the lock badge
    const lockedBadge = page.getByText("Chưa tham gia").first();
    await expect(lockedBadge).toBeVisible();
  });

  test("locked course row has a disabled chevron button (not a link)", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học" })).toBeVisible();

    // Find the first row with a "Chưa tham gia" badge
    const lockedRow = page.getByRole("row").filter({ hasText: "Chưa tham gia" }).first();
    await expect(lockedRow).toBeVisible();

    // The locked row should have a disabled button (not a link)
    const disabledBtn = lockedRow.getByRole("button", { disabled: true });
    await expect(disabledBtn).toBeVisible();

    // And it must NOT have a navigable link for the chevron
    // (the course title cell spans but no href link goes to the course)
    // Verify the disabled button does not act as a link
    const enabledLink = lockedRow.getByRole("link");
    // Locked rows have no active navigation link
    const count = await enabledLink.count();
    expect(count).toBe(0);
  });

  test("locked course row is rendered with reduced opacity (opacity-60 class)", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // At least one TableRow with opacity-60 must exist for locked courses
    const dimmedRow = page.locator("tr.opacity-60, tr[class*='opacity-60']").first();
    await expect(dimmedRow).toBeVisible();
  });
});

// ── Manager does NOT see locked courses ───────────────────────────────────

test.describe("Course list — no locks for manager (userPage = alice)", () => {
  test("admin alice does not see any Chưa tham gia badge", async ({ userPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học" })).toBeVisible();

    // Managers bypass canAccess check — no lock badges shown
    await expect(page.getByText("Chưa tham gia")).not.toBeVisible();
  });

  test("admin alice sees a Tạo khóa học button (canManage)", async ({ userPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).toBeVisible();
  });
});
