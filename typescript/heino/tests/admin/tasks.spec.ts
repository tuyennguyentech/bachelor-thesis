import { test, expect } from "../fixtures";

const TASKS_URL = "/admin/tasks";

test.describe("Admin Tasks Monitor page", () => {
  test("renders stats cards and heading", async ({ adminPage: page }) => {
    await page.goto(TASKS_URL, { waitUntil: "domcontentloaded" });
    
    // Check page header
    await expect(page.getByRole("heading", { name: "Danh sách tác vụ", level: 2 })).toBeVisible();
    
    // Check stats cards
    await expect(page.getByText("Đang hoạt động (Toàn hệ thống)", { exact: true })).toBeVisible();
    await expect(page.getByText("Thành công (Trang này)", { exact: true })).toBeVisible();
    await expect(page.getByText("Thất bại / Đã huỷ (Trang này)", { exact: true })).toBeVisible();
  });

  test("renders tasks list table", async ({ adminPage: page }) => {
    await page.goto(TASKS_URL, { waitUntil: "domcontentloaded" });

    // Check action buttons
    await expect(page.getByRole("button", { name: "Chỉ hiển thị đang chạy" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Làm mới" })).toBeVisible();

    // Check table headers
    await expect(page.getByRole("columnheader", { name: "ID" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Loại tác vụ" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tiến độ & Thông điệp" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Thời gian chạy" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Ngày tạo" })).toBeVisible();
  });

  test("renders pagination controls", async ({ adminPage: page }) => {
    await page.goto(TASKS_URL, { waitUntil: "domcontentloaded" });
    
    // Check pagination info and buttons
    await expect(page.getByText("Trang 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Trang trước" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Trang sau" })).toBeVisible();
  });
});
