import {
  test,
  expect,
  loginAs,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  USER_EMAIL,
  USER_PASSWORD,
  goToSeededLesson,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
  SEED_DSA_LESSON_BIG_O,
} from "../fixtures";

async function waitForRecentAccess(page: import("@playwright/test").Page, type: string, title: string) {
  await page.waitForFunction(
    ({ expectedType, expectedTitle }) => {
      const cookie = document.cookie
        .split("; ")
        .find((part) => part.startsWith("dyadia_recent_access="))
        ?.slice("dyadia_recent_access=".length);
      if (!cookie) return false;
      try {
        const entries = JSON.parse(decodeURIComponent(cookie)) as { title?: string; type?: string; l?: string; t?: string }[];
        return entries.some((entry) => {
          const type = entry.type ?? entry.t;
          const title = entry.title ?? entry.l;
          return type === expectedType && title === expectedTitle;
        });
      } catch {
        return false;
      }
    },
    { expectedType: type, expectedTitle: title },
  );
}

test.describe("Dashboard home", () => {
  test("shows personalized greeting", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Xin chào");
  });

  test("shows primary actions for organization and profile", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Tạo tổ chức" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Hồ sơ" }).first()).toBeVisible();
  });

  test("shows recent access section", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Truy cập gần đây" })).toBeVisible();
  });

  test("recent access records the concrete child page that was opened", async ({ teacherPage: page }) => {
    await page.context().clearCookies({ name: "dyadia_recent_access" });

    await goToSeededLesson(page, SEED_DSA_LESSON_BIG_O);
    await expect(page.getByRole("heading", { name: SEED_DSA_LESSON_BIG_O })).toBeVisible();
    await waitForRecentAccess(page, "lesson", SEED_DSA_LESSON_BIG_O);

    await page.goto("/dashboard");
    const recentSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Truy cập gần đây" }) });
    const firstRecent = recentSection.getByRole("link", { name: /Mở lại/ }).first();
    await expect(firstRecent).toContainText(SEED_DSA_LESSON_BIG_O);
    await expect(firstRecent).toContainText(SEED_DSA_COURSE_TITLE);
    await expect(firstRecent).toContainText("Bài học");
  });

  test("recent access records organization subpages for normal dashboard users", async ({ studentPage: page }) => {
    await page.context().clearCookies({ name: "dyadia_recent_access" });

    await page.goto(`/dashboard/organizations/${SEED_HUST_CS_SLUG}/members`);
    await expect(page.getByRole("heading", { name: "Thành viên" })).toBeVisible();
    await waitForRecentAccess(page, "organization-members", "Thành viên");

    await page.goto("/dashboard");
    const recentSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Truy cập gần đây" }) });
    const firstRecent = recentSection.getByRole("link", { name: /Mở lại/ }).first();
    await expect(firstRecent).toContainText("Thành viên");
    await expect(firstRecent).toContainText("Thành viên tổ chức");
  });

  test("recent access updates after visiting multiple dashboard shell pages", async ({ userPage: page }) => {
    await page.context().clearCookies({ name: "dyadia_recent_access" });

    await page.goto("/dashboard/organizations");
    await expect(page.getByRole("heading", { name: "Tổ chức của tôi" })).toBeVisible();
    await waitForRecentAccess(page, "dashboard-organizations", "Tổ chức của tôi");

    await page.goto("/dashboard/profile");
    await expect(page.getByRole("heading", { name: "Hồ sơ cá nhân" })).toBeVisible();
    await waitForRecentAccess(page, "dashboard-profile", "Hồ sơ cá nhân");

    await page.goto("/dashboard");
    const recentSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Truy cập gần đây" }) });
    const firstRecent = recentSection.getByRole("link", { name: /Mở lại/ }).first();
    await expect(firstRecent).toContainText("Hồ sơ cá nhân");
    await expect(firstRecent).toContainText("Trang chính · Hồ sơ");
  });

  test("admin visiting /dashboard is redirected to /admin", async ({ adminPage: page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/admin/);
  });

  test("recent access is isolated between accounts in the same browser", async ({ page, baseURL }) => {
    await page.context().clearCookies();

    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD, baseURL);
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "Người dùng" })).toBeVisible();
    await waitForRecentAccess(page, "admin-users", "Người dùng");

    await loginAs(page, USER_EMAIL, USER_PASSWORD, baseURL);
    await page.goto("/dashboard");
    const recentSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Truy cập gần đây" }) });
    await expect(recentSection).not.toContainText("Admin · Người dùng");
    await expect(recentSection).not.toContainText("Người dùng");

    await page.goto("/dashboard/profile");
    await expect(page.getByRole("heading", { name: "Hồ sơ cá nhân" })).toBeVisible();
    await waitForRecentAccess(page, "dashboard-profile", "Hồ sơ cá nhân");
    await page.goto("/dashboard");
    await expect(recentSection.getByRole("link", { name: /Mở lại/ }).first()).toContainText("Hồ sơ cá nhân");
  });

  test("org list action navigates to /dashboard/organizations", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Tất cả tổ chức" }).click();
    await expect(page).toHaveURL(/\/dashboard\/organizations/);
  });

  test("profile action navigates to /dashboard/profile", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Hồ sơ" }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/profile/);
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout redirects to /login", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Đăng xuất" }).click();
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Dashboard sidebar navigation", () => {
  test("sidebar has Tổ chức and Hồ sơ links", async ({ userPage: page }) => {
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Tổ chức" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Hồ sơ" })).toBeVisible();
  });
});
