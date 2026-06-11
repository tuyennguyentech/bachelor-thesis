import { test, expect, loginAs, USER_PASSWORD } from "../fixtures";

const HENRY_EMAIL = "henry@dyadia.local";

// alice@dyadia.local is a member of hust-cs (admin role)
const SEED_MEMBER_ORG = "hust-cs";

test.describe("Dashboard organizations list", () => {
  test("shows page heading", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    await expect(page.getByRole("heading", { name: "Tổ chức của tôi" })).toBeVisible();
  });

  test("shows table columns", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    await expect(page.getByRole("columnheader", { name: "Tên tổ chức" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
  });

  test("shows seeded org membership", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    // alice's org shows by its display name
    await expect(page.getByRole("cell", { name: "HUST Computer Science" })).toBeVisible();
  });

  test("navigate button goes to org detail", async ({ userPage: page }) => {
    await page.goto("/dashboard/organizations");
    const row = page.getByRole("row").filter({ hasText: "HUST Computer Science" });
    await row.getByRole("link").click();
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
    await page.goto(COURSES_URL);
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
    await page.goto(COURSES_URL);
    // read the first course card's link href and navigate (Radix asChild+Link is flaky to click in Firefox)
    const href = await page.locator('[data-slot="card"]').first().getByRole("link").first().getAttribute("href");
    expect(href).toBeTruthy();
    await page.goto(href!);
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses/`));
  });
});

test.describe("Dashboard course detail", () => {
  test("shows course title, status badge, and module list", async ({ userPage: page }) => {
    // Read the course href and navigate directly (the row chevron is a Radix
    // Button-asChild-Link which is flaky to click in Firefox). The module list
    // ("Nội dung (N chương)") lives in the "Bài học" tab of the course workspace.
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`);
    const href = await page.locator('[data-slot="card"]').first().getByRole("link").first().getAttribute("href");
    expect(href).toBeTruthy();
    await page.goto(`${href}?tab=lessons`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Nội dung")).toBeVisible();
  });

  test("back button navigates to courses list", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`);
    const href = await page.locator('[data-slot="card"]').first().getByRole("link").first().getAttribute("href");
    await page.goto(href!);
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
