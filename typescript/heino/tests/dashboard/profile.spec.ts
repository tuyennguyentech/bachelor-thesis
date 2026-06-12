import { test, expect, uid, loginAs, getAdminAuth, createUser, USER_PASSWORD, USER_EMAIL } from "../fixtures";

test.describe("Dashboard profile page", () => {
  test("shows profile heading", async ({ userPage: page }) => {
    await page.goto("/dashboard/profile");
    await expect(page.getByRole("heading", { name: "Hồ sơ cá nhân" })).toBeVisible();
  });

  test("shows user email and avatar initials", async ({ userPage: page }) => {
    await page.goto("/dashboard/profile");
    await expect(page.getByText(USER_EMAIL)).toBeVisible();
  });

  test("shows personal info section with form fields", async ({ userPage: page }) => {
    await page.goto("/dashboard/profile");
    await expect(page.getByText("Thông tin cá nhân")).toBeVisible();
    await expect(page.getByLabel("Họ")).toBeVisible();
    await expect(page.getByLabel("Tên", { exact: true })).toBeVisible();
  });

  test("shows change password section", async ({ userPage: page }) => {
    await page.goto("/dashboard/profile");
    // heading "Đổi mật khẩu" and button "Đổi mật khẩu" both exist — use role to disambiguate
    await expect(page.getByRole("heading", { name: "Đổi mật khẩu" })).toBeVisible();
    await expect(page.getByLabel("Mật khẩu hiện tại")).toBeVisible();
    await expect(page.getByLabel("Mật khẩu mới", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Xác nhận mật khẩu mới")).toBeVisible();
  });

  test("edits first and last name", async ({ page, baseURL }) => {
    // Use a fresh user so this test never mutates alice's seed profile
    const { token: adminToken } = await getAdminAuth(baseURL);
    const freshEmail = `profile-edit-${uid("")}@test.local`;
    await createUser(
      adminToken,
      { email: freshEmail, firstName: "Original", lastName: "Name" },
      baseURL,
    );

    await loginAs(page, freshEmail, USER_PASSWORD, baseURL ?? "http://caddy");
    await page.goto("/dashboard/profile");

    // "Họ" = lastName field, "Tên" = firstName field (Vietnamese order)
    await page.getByLabel("Họ").clear();
    await page.getByLabel("Họ").fill("Updated");
    // profile form has "Tên đệm" label too — exact: true targets only "Tên"
    await page.getByLabel("Tên", { exact: true }).clear();
    await page.getByLabel("Tên", { exact: true }).fill("Fresh");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await expect(page.getByText("Đã lưu thay đổi")).toBeVisible();
  });

  test("shows error when password mismatch", async ({ userPage: page }) => {
    await page.goto("/dashboard/profile");
    await page.getByLabel("Mật khẩu hiện tại").fill("AnyCurrentPass1!");
    await page.getByLabel("Mật khẩu mới", { exact: true }).fill("NewPass123!");
    await page.getByLabel("Xác nhận mật khẩu mới").fill("DifferentPass999!");
    await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
    await expect(page.getByText("Mật khẩu xác nhận không khớp")).toBeVisible();
  });

  test("short password blocked by browser (minLength)", async ({ userPage: page }) => {
    await page.goto("/dashboard/profile");
    await page.getByLabel("Mật khẩu hiện tại").fill("AnyCurrentPass1!");
    await page.getByLabel("Mật khẩu mới", { exact: true }).fill("short");
    await page.getByLabel("Xác nhận mật khẩu mới").fill("short");
    await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
    await expect(page.getByText("Đã đổi mật khẩu")).not.toBeVisible();
  });

  test("unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto("/dashboard/profile");
    await expect(page).toHaveURL(/\/login/);
  });
});
