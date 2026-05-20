import { test, expect, ADMIN_EMAIL, ADMIN_PASSWORD } from "./fixtures";

test.describe("Silent refresh flow", () => {
  test("expired access cookie triggers silent refresh, no /login redirect", async ({ adminPage: page, context }) => {
    // adminPage fixture đã login → có cả 2 cookies
    const before = await context.cookies();
    const refreshBefore = before.find((c) => c.name === "dyadia_refresh")?.value;
    expect(refreshBefore).toBeTruthy();

    // Force-expire access cookie (giữ refresh nguyên).
    await context.clearCookies({ name: "dyadia_access" });

    // Navigate đến trang protected → middleware refresh ngầm → page render OK.
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/admin\/users/);

    const after = await context.cookies();
    expect(after.find((c) => c.name === "dyadia_access")?.value).toBeTruthy();
    // Refresh token rotate mỗi lần refresh.
    expect(after.find((c) => c.name === "dyadia_refresh")?.value).not.toEqual(refreshBefore);
  });

  test("expired access + invalid refresh redirects to /login?next=... + clears cookies", async ({ adminPage: page, context }) => {
    await context.clearCookies({ name: "dyadia_access" });
    const host = new URL(page.url()).hostname;
    // Replace refresh cookie với token rác
    await context.clearCookies({ name: "dyadia_refresh" });
    await context.addCookies([
      { name: "dyadia_refresh", value: "not-a-real-token", domain: host, path: "/" },
    ]);

    await page.goto("/admin/organizations");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Forganizations/);

    const after = await context.cookies();
    expect(after.find((c) => c.name === "dyadia_access")).toBeFalsy();
    expect(after.find((c) => c.name === "dyadia_refresh")).toBeFalsy();
  });

  test("after re-login user returns to original page (bug 2 fix)", async ({ adminPage: page, context }) => {
    await context.clearCookies({ name: "dyadia_access" });
    const host = new URL(page.url()).hostname;
    await context.clearCookies({ name: "dyadia_refresh" });
    await context.addCookies([
      { name: "dyadia_refresh", value: "bogus", domain: host, path: "/" },
    ]);

    const targetPath = "/admin/organizations";
    await page.goto(targetPath);
    // Middleware refresh fail → redirect /login với ?next=
    await expect(page).toHaveURL(/\/login\?next=/);

    // Login lại
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Mật khẩu").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    // Quay về đúng trang gốc (không phải /admin/users default)
    await page.waitForURL(new RegExp(targetPath));
    await expect(page).toHaveURL(new RegExp(targetPath));
  });
});
