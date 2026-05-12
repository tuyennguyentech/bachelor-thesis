import { test, expect } from "../fixtures";

const USERS_URL = "/admin/users";

function uniqueEmail() {
  return `e2e.user.${Date.now()}@test.local`;
}

test.describe("Users list page", () => {
  test("renders heading, create button, and table columns", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await expect(page.getByRole("heading", { name: "Người dùng" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tạo user" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Vai trò" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
  });

  test("shows seeded users", async ({ adminPage: page }) => {
    await page.goto(USERS_URL + "?q=alice%40dyadia.local");
    await expect(page.getByRole("cell", { name: "alice@dyadia.local" })).toBeVisible();
  });

  test("opens create-user dialog", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tạo user mới" })).toBeVisible();
  });

  test("dialog has required form fields", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Họ")).toBeVisible();
    await expect(dialog.getByLabel("Tên")).toBeVisible();
    await expect(dialog.getByLabel("Email")).toBeVisible();
    await expect(dialog.getByLabel("Mật khẩu")).toBeVisible();
  });

  test("closes dialog on Hủy", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("empty submit keeps dialog open (required fields)", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("creates a new user and shows them in the table", async ({ adminPage: page }) => {
    const email = uniqueEmail();
    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Họ").fill("E2E");
    await dialog.getByLabel("Tên").fill("User");
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByLabel("Mật khẩu").fill("TestPass123!");
    await dialog.getByRole("button", { name: "Tạo" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("cell", { name: email })).toBeVisible();
  });

  test("search filters users by email", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await page.getByPlaceholder("ID / email...").fill("alice@dyadia.local");
    await page.waitForURL(/q=alice/);
    await expect(page.getByRole("cell", { name: "alice@dyadia.local" })).toBeVisible();
  });

  test("search with no match shows empty state", async ({ adminPage: page }) => {
    await page.goto(USERS_URL);
    await page.getByPlaceholder("ID / email...").fill("does-not-exist@nowhere.local");
    await page.waitForURL(/q=does-not-exist/);
    await expect(page.getByText("Không có user nào")).toBeVisible();
  });
});

test.describe("User detail page", () => {
  let userEmail: string;
  let userUrl: string;

  test.beforeEach(async ({ adminPage: page }) => {
    userEmail = uniqueEmail();

    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Họ").fill("E2E");
    await dialog.getByLabel("Tên").fill("Detail");
    await dialog.getByLabel("Email").fill(userEmail);
    await dialog.getByLabel("Mật khẩu").fill("TestPass123!");
    await dialog.getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Navigate to the user's detail page via search + actions menu
    await page.goto(`${USERS_URL}?q=${encodeURIComponent(userEmail)}`);
    const row = page.getByRole("row").filter({ hasText: userEmail });
    await row.getByRole("button").click();
    const link = page.getByRole("menuitem", { name: "Xem chi tiết" });
    await expect(link).toBeVisible();
    userUrl = (await link.getAttribute("href"))!;
    await page.keyboard.press("Escape");
    await page.goto(userUrl);
  });

  test("shows user name and email", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(userEmail).first()).toBeVisible();
  });

  test("shows all sections", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await expect(page.getByText("Thông tin cá nhân")).toBeVisible();
    await expect(page.getByText("Tài khoản")).toBeVisible();
    await expect(page.getByText("Đổi mật khẩu")).toBeVisible();
    await expect(page.getByText("Xóa user")).toBeVisible();
  });

  test("edits first and last name", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await page.getByLabel("Họ").clear();
    await page.getByLabel("Họ").fill("Nguyễn");
    await page.getByLabel("Tên", { exact: true }).clear();
    await page.getByLabel("Tên", { exact: true }).fill("Văn A");
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText("Đã lưu")).toBeVisible();
  });

  test("shows error when password mismatch", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await page.getByLabel("Mật khẩu mới").fill("NewPass123!");
    await page.getByLabel("Xác nhận mật khẩu").fill("DifferentPass999!");
    await page.getByRole("button", { name: "Đặt mật khẩu" }).click();
    await expect(page.getByText("Mật khẩu xác nhận không khớp")).toBeVisible();
  });

  test("short password blocked by browser (minLength)", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await page.getByLabel("Mật khẩu mới").fill("short");
    await page.getByLabel("Xác nhận mật khẩu").fill("short");
    await page.getByRole("button", { name: "Đặt mật khẩu" }).click();
    // native minLength=8 prevents submit; no success message
    await expect(page.getByText("Đã đổi mật khẩu")).not.toBeVisible();
  });

  test("changes password successfully", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await page.getByLabel("Mật khẩu mới").fill("NewSecurePass123!");
    await page.getByLabel("Xác nhận mật khẩu").fill("NewSecurePass123!");
    await page.getByRole("button", { name: "Đặt mật khẩu" }).click();
    await expect(page.getByText("Đã đổi mật khẩu")).toBeVisible();
  });

  test("updates user role", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    // Vai trò select is in the Tài khoản section
    const roleTrigger = page.locator("[data-slot='select-trigger']").first();
    await roleTrigger.click();
    await page.getByRole("option", { name: "Quản trị" }).click();
    await expect(roleTrigger).toContainText("Quản trị");
  });

  test("updates user status", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    // Trạng thái select is the second select in Tài khoản section
    const statusTrigger = page.locator("[data-slot='select-trigger']").nth(1);
    await statusTrigger.click();
    await page.getByRole("option", { name: "Vô hiệu" }).click();
    await expect(statusTrigger).toContainText("Vô hiệu");
  });

  test("deletes user and redirects to list", async ({ adminPage: page }) => {
    await page.goto(userUrl);
    await page.getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByRole("alertdialog").getByText("Xóa user?")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await page.waitForURL(/\/admin\/users$/);
    await expect(page).toHaveURL(/\/admin\/users$/);
  });
});

test.describe("User status from list page", () => {
  test("disables an active user from the actions menu", async ({ adminPage: page }) => {
    // Create a user, then disable them from the list
    const email = uniqueEmail();
    await page.goto(USERS_URL);
    await page.getByRole("button", { name: "Tạo user" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Họ").fill("E2E");
    await dialog.getByLabel("Tên").fill("Disable");
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByLabel("Mật khẩu").fill("TestPass123!");
    await dialog.getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: email });
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Vô hiệu hóa" }).click();

    // After revalidation the row shows "Vô hiệu" status badge
    await expect(row.getByText("Vô hiệu")).toBeVisible();
  });
});
