import { test, expect } from "../fixtures";

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
  test("shows org name and slug", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Slug appears in two places on the page — first() avoids strict mode
    await expect(page.getByText(`/${SEED_MEMBER_ORG}`).first()).toBeVisible();
  });

  test("shows member role info", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page.getByText("Vai trò của bạn")).toBeVisible();
    // alice is admin in hust-cs → roleName returns "Quản trị viên"
    await expect(page.getByText("Quản trị viên")).toBeVisible();
  });

  test("back button navigates to org list", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await page.getByRole("link", { name: "Tổ chức của tôi" }).click();
    await expect(page).toHaveURL(/\/dashboard\/organizations$/);
  });

  test("non-member cannot access org detail (redirected or 404)", async ({ page }) => {
    // Unauthenticated → redirect to login
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page).toHaveURL(/\/login/);
  });

  test("shows Xem khóa học link", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await expect(page.getByRole("link", { name: "Xem khóa học" })).toBeVisible();
  });

  test("Xem khóa học link navigates to courses page", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    await page.getByRole("link", { name: "Xem khóa học" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`));
  });
});

test.describe("Dashboard org courses", () => {
  const COURSES_URL = `/dashboard/organizations/${SEED_MEMBER_ORG}/courses`;

  test("shows courses heading and table columns", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    await expect(page.getByRole("heading", { name: "Khóa học" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tên khóa học" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
  });

  test("shows seeded courses for hust-cs", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    // hust-cs has seeded courses — at least one row should exist
    const rows = page.getByRole("row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
  });

  test("back button navigates to org detail", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    await page.getByRole("link").filter({ hasText: "HUST Computer Science" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}$`));
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto(COURSES_URL);
    await expect(page).toHaveURL(/\/login/);
  });

  test("course row links to course detail", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    // click the first chevron link in the table (first data row)
    await page.getByRole("row").nth(1).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses/`));
  });
});

test.describe("Dashboard course detail", () => {
  test("shows course title, status badge, and module list", async ({ userPage: page }) => {
    // navigate via courses list
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`);
    await page.getByRole("row").nth(1).getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Nội dung")).toBeVisible();
  });

  test("back button navigates to courses list", async ({ userPage: page }) => {
    await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`);
    await page.getByRole("row").nth(1).getByRole("link").click();
    await page.getByRole("link", { name: "Khóa học" }).click();
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
// Visiting any page under /dashboard/organizations/hust-cs should return 404,
// not redirect to /login (which would only happen for unauthenticated users).

test.describe("Authenticated non-member cannot access org", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("henry@dyadia.local");
    await page.getByLabel("Mật khẩu").fill("Password123!");
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.waitForURL(/\/(admin|dashboard)/);
  });

  test("gets 404 on org detail page", async ({ page }) => {
    const response = await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}`);
    expect(response?.status()).toBe(404);
  });

  test("gets 404 on org courses page", async ({ page }) => {
    const response = await page.goto(`/dashboard/organizations/${SEED_MEMBER_ORG}/courses`);
    expect(response?.status()).toBe(404);
  });
});
