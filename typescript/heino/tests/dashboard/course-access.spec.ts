/**
 * E2E tests — course list lock indicator and access control.
 *
 * The courses list page (/dashboard/organizations/hust-cs/courses) renders a
 * CARD-BASED layout (redesigned from the old table layout) with two sections:
 *
 *   Section 1 — "Khóa học của bạn":
 *     - Enrolled/accessible courses get a card with:
 *         - Badge "Đang tham gia" in footer
 *         - Button/Link "Vào học" (student) or "Quản lý" (manager)
 *
 *   Section 2 — "Khóa học khác trong tổ chức":
 *     - Non-enrolled courses get a card with:
 *         - Badge "Chưa tham gia" in footer
 *         - Badge "Yêu cầu tham gia" in header
 *         - Button/Link "Yêu cầu" (navigates to the course's lock screen)
 *
 * Bob (studentPage) is enrolled in "Cấu trúc dữ liệu và Giải thuật" (DSA)
 * but NOT enrolled in at least one other hust-cs course.
 *
 * Alice (userPage) is org ADMIN so `canManage=true` → she sees no locks
 * and a "Tạo khóa học" button.
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

// ── Student sees enrolled course in "Khóa học của bạn" section ────────────

test.describe("Course list — enrolled course (studentPage = bob)", () => {
  test("'Khóa học của bạn' section heading is visible", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Khóa học của bạn" })).toBeVisible();
  });

  test("enrolled DSA course card shows 'Đang tham gia' badge", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();

    // The card for DSA should show "Đang tham gia" badge
    const dsaCard = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    await expect(dsaCard).toBeVisible();
    await expect(dsaCard.getByText("Đang tham gia")).toBeVisible();
  });

  test("enrolled DSA course card has a 'Vào học' link (not disabled)", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );

    // The accessible card footer has a "Vào học" link for students
    const vaoHocLink = page.getByRole("link", { name: /Vào học/ });
    await expect(vaoHocLink).toBeVisible();
    const href = await vaoHocLink.getAttribute("href");
    expect(href).toMatch(/\/courses\//);
  });

  test("clicking 'Vào học' navigates to the course workspace", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const vaoHocLink = page.getByRole("link", { name: /Vào học/ }).first();
    const href = await vaoHocLink.getAttribute("href");
    await page.goto(href!, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: SEED_DSA_COURSE_TITLE })).toBeVisible();
  });
});

// ── Student sees locked courses in "Khóa học khác trong tổ chức" section ──

test.describe("Course list — locked course cards (studentPage = bob)", () => {
  test("'Khóa học khác trong tổ chức' section is visible with locked courses", async ({ studentPage: page }) => {
    // Load all courses in hust-cs (no search filter — show everything)
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();

    // The locked section heading should be visible
    await expect(
      page.getByRole("heading", { name: "Khóa học khác trong tổ chức" }),
    ).toBeVisible();
  });

  test("locked course card shows 'Chưa tham gia' badge", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();

    // At least one card in the locked section carries the "Chưa tham gia" badge
    const lockedBadge = page.getByText("Chưa tham gia").first();
    await expect(lockedBadge).toBeVisible();
  });

  test("locked course card shows 'Yêu cầu tham gia' header badge", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // Locked cards have a "Yêu cầu tham gia" badge in their header area
    await expect(page.getByText("Yêu cầu tham gia").first()).toBeVisible();
  });

  test("locked course card has a 'Yêu cầu' link (navigates to lock screen)", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // The locked card footer has a "Yêu cầu" link (not a disabled button)
    const requestLink = page.getByRole("link", { name: /^Yêu cầu$/ }).first();
    await expect(requestLink).toBeVisible();

    // It should link to a course detail page
    const href = await requestLink.getAttribute("href");
    expect(href).toMatch(/\/courses\//);
  });

  test("clicking 'Yêu cầu' on locked course navigates to the course lock screen", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // Navigate using href to avoid Radix/Firefox flakiness
    const requestLink = page.getByRole("link", { name: /^Yêu cầu$/ }).first();
    const href = await requestLink.getAttribute("href");
    await page.goto(href!, { waitUntil: "domcontentloaded" });

    // Should land on the course lock screen
    // "Khóa học đang bị khóa" is rendered as a CardTitle (generic element, not a heading role)
    await expect(
      page.getByText("Khóa học đang bị khóa"),
    ).toBeVisible();
  });
});

// ── Manager does NOT see "Khóa học khác trong tổ chức" section ────────────

test.describe("Course list — no locked section for manager (userPage = alice)", () => {
  test("admin alice does not see 'Khóa học khác trong tổ chức' section", async ({ userPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();

    // Managers bypass canAccess check — locked section is not rendered
    await expect(
      page.getByRole("heading", { name: "Khóa học khác trong tổ chức" }),
    ).not.toBeVisible();
  });

  test("admin alice does not see 'Chưa tham gia' badge", async ({ userPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();

    await expect(page.getByText("Chưa tham gia")).not.toBeVisible();
  });

  test("admin alice sees 'Tạo khóa học' button (canManage)", async ({ userPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).toBeVisible();
  });

  test("admin alice sees 'Quản lý' link on course cards (not 'Vào học')", async ({ userPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    // Manager sees "Quản lý" instead of "Vào học"
    await expect(page.getByRole("link", { name: /Quản lý/ }).first()).toBeVisible();
  });
});
