import { test, expect, loginAs, USER_PASSWORD, SEED_DSA_COURSE_TITLE } from "../fixtures";

const HENRY_EMAIL = "henry@dyadia.local";

// alice@dyadia.local is a member of hust-cs (admin role)
const SEED_MEMBER_ORG = "hust-cs";

/**
 * Return the detail href of a STABLE seeded course (DSA, which alice manages) by
 * searching with ?q=. The unfiltered courses list is NOT reliable here: other
 * specs create courses in hust-cs during a full parallel run, so "the first card"
 * is non-deterministic. Searching by title pins us to a known course regardless.
 */
async function seededCourseHref(page: import("@playwright/test").Page): Promise<string> {
  await page.goto(
    `/dashboard/organizations/${SEED_MEMBER_ORG}/courses?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
    { waitUntil: "domcontentloaded" },
  );
  const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
  const href = await card.getByRole("link").first().getAttribute("href");
  if (!href) throw new Error(`No detail link on seeded course card "${SEED_DSA_COURSE_TITLE}"`);
  return href;
}

test.describe("Dashboard organizations list", () => {
  test("shows page heading", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    await expect(page.getByRole("heading", { name: "Tổ chức của tôi" })).toBeVisible();
  });

  test("renders membership cards with role + status", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    const card = page.getByTestId("org-card").filter({ hasText: "HUST Computer Science" });
    await expect(card).toBeVisible();
    // alice is an admin in hust-cs → roleName returns "Quản trị viên"
    await expect(card.getByText("Quản trị viên")).toBeVisible();
  });

  test("shows seeded org membership", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    // alice's org shows by its display name
    await expect(page.getByText("HUST Computer Science")).toBeVisible();
  });

  test("clicking a membership card goes to org detail", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    const card = page.getByTestId("org-card").filter({ hasText: "HUST Computer Science" });
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}`));
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto("/dashboard/organizations");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Dashboard org detail", () => {
  test("shows org name without exposing the slug in the sidebar card", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(`/${SEED_MEMBER_ORG}`)).not.toBeVisible();
  });

  test("shows member role info", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    // alice is admin in hust-cs → roleName returns "Quản trị viên"
    await expect(page.getByText("Quản trị viên")).toBeVisible();
  });

  test("back button navigates to dashboard home", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await page.getByRole("link", { name: "Trang chính" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("non-member cannot access org detail (redirected or 404)", async ({ page }) => {
    // Unauthenticated → redirect to login
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page).toHaveURL(/\/login/);
  });

  test("shows Khóa học link in organization sidebar", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page.getByRole("link", { name: "Khóa học", exact: true })).toBeVisible();
  });

  test("Khóa học link navigates to courses page", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await page.getByRole("link", { name: "Khóa học", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`));
  });
});

test.describe("Dashboard org courses", () => {
  const COURSES_URL = `/dashboard/organizations/${SEED_MEMBER_ORG}/courses`;

  test("shows courses heading and table columns", async ({ userPage: page }) => {
    // Filter to a course alice manages so the "Khóa học của bạn" section renders
    // regardless of how many courses other specs created in this shared org during
    // a parallel run (the unfiltered page-1 list can be all freshly-created courses).
    await page.goto(`${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();
    // Courses render as cards; alice (admin of hust-cs) sees her courses under "Khóa học của bạn"
    await expect(page.getByRole("heading", { name: "Khóa học của bạn" })).toBeVisible();
  });

  test("shows seeded courses for hust-cs", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    // hust-cs has seeded courses — at least one course card should render
    const cards = page.locator('[data-slot="card"]');
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test("back button navigates to org detail", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    await page.getByRole("link", { name: "Tổng quan", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}$`));
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto(COURSES_URL);
    await expect(page).toHaveURL(/\/login/);
  });

  test("course card links to course detail", async ({ userPage: page }) => {
    const href = await seededCourseHref(page);
    await page.goto(href);
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses/`));
  });
});

test.describe("Dashboard course detail", () => {
  test("shows course title, status badge, and module list", async ({ userPage: page }) => {
    // The module list ("Nội dung (N chương)") lives in the "Bài học" tab.
    const href = await seededCourseHref(page);
    // Strip any query (a manager card CTA links to ...?mode=learn) before adding
    // the tab, so we don't build a malformed "?mode=learn?tab=lessons".
    const base = href.split("?")[0].replace(/\/$/, "");
    await page.goto(`${base}?tab=lessons`, { waitUntil: "domcontentloaded" });
    // The "Bài học" tab heading is "Nội dung (N chương)". Match the heading
    // specifically — a bare getByText("Nội dung") also matches the "Chưa có nội
    // dung" empty-lesson badges (substring), which trips strict mode.
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
  });

  test("back button navigates to courses list", async ({ userPage: page }) => {
    const href = await seededCourseHref(page);
    await page.goto(href);
    // The course workspace sidebar has a "Danh sách khóa học" back link
    await page.getByRole("link", { name: "Danh sách khóa học" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses$`));
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    // need a valid course URL — use the list page first
    // for unauthenticated we just need any URL under this path
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`);
    await expect(page).toHaveURL(/\/login/);
  });
});

// ── Authenticated non-member gets 404 ─────────────────────────────────────
//
// henry@dyadia.local has an account but is NOT seeded as a member of hust-cs.
// Visiting any page under /dashboard/organizations/hust-cs should return a 404
// page (rendered inline at the same URL), not redirect to /login (which would
// only happen for unauthenticated users).
//
// Implementation note: getOrganizationBySlug returns PermissionDenied for
// non-members to prevent org slug enumeration. The frontend handles
// PermissionDenied by calling Next.js notFound(), which renders a 404 inline
// (URL unchanged). The URL does NOT change to /unauthorized because the
// membership check fails at the RPC layer before requireOrgMember() is reached.

test.describe("Authenticated non-member cannot access org", () => {
  // Use direct cookie injection (same as other fixtures) to reliably authenticate
  // henry in the HTTP test environment. Form-based login sets cookies with
  // Secure: true (production mode) which are not sent over HTTP, causing the
  // proxy to treat the session as unauthenticated.
  test.beforeEach(async ({ page, baseURL }) => {
    await loginAs(page, HENRY_EMAIL, USER_PASSWORD, baseURL ?? "http://caddy");
  });

  // henry is a valid user but NOT a member of hust-cs.
  // The backend getOrganizationBySlug returns PermissionDenied for non-members;
  // the frontend calls notFound() → Next.js renders a 404 page at the same URL.
  test("gets 404 on org detail page", async ({ page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`, { waitUntil: "domcontentloaded" });
    // URL stays at the org page (Next.js notFound renders inline, no redirect)
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}`));
    // Next.js not-found page renders the custom not-found.tsx (or default 404)
    await expect(page.getByText("404")).toBeVisible({ timeout: 5000 });
  });

  test("gets 404 on org courses page", async ({ page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`, { waitUntil: "domcontentloaded" });
    // URL stays at the courses page (Next.js notFound renders inline, no redirect)
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`));
    await expect(page.getByText("404")).toBeVisible({ timeout: 5000 });
  });
});
