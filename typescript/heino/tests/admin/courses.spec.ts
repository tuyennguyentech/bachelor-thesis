/**
 * E2E tests for admin course management.
 *
 * Requires a running dev environment with dev_seed_enabled = true so that the
 * org `dyadia-demo` and its members are available. The tests create courses
 * with unique suffixed titles to avoid collisions across parallel runs.
 */

import { test, expect } from "../fixtures";

const ORG_SLUG = process.env.TEST_ORG_SLUG ?? "dyadia-demo";
const COURSES_URL = `/admin/organizations/${ORG_SLUG}/courses`;

function uniqueTitle(base: string) {
  return `${base} ${Date.now()}`;
}

test.describe("Course list page", () => {
  test("renders the courses table", async ({ adminPage: page }) => {
    await page.goto(COURSES_URL);
    await expect(page.getByRole("heading", { name: "Khóa học" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tên" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Trạng thái" })).toBeVisible();
  });

  test("back button navigates to org detail", async ({ adminPage: page }) => {
    await page.goto(COURSES_URL);
    await page.locator(`a[href='/admin/organizations/${ORG_SLUG}']`).first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/organizations/${ORG_SLUG}$`));
  });

  test("opens create-course dialog", async ({ adminPage: page }) => {
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tạo khóa học mới" })).toBeVisible();
  });

  test("creates a new course and shows it in the table", async ({ adminPage: page }) => {
    const title = uniqueTitle("Khóa học E2E");
    const description = "Mô tả cho khóa học tự động";

    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(title);
    await page.getByLabel("Mô tả").fill(description);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();

    // dialog closes after success
    await expect(page.getByRole("dialog")).not.toBeVisible();
    // new course appears in table
    await expect(page.getByRole("cell", { name: title })).toBeVisible();
  });

  test("shows validation error when title is empty", async ({ adminPage: page }) => {
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    // leave title empty, submit
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    // browser native required validation prevents submit, dialog stays open
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

test.describe("Course detail page", () => {
  let courseTitle: string;
  let courseUrl: string;

  test.beforeEach(async ({ adminPage: page }) => {
    courseTitle = uniqueTitle("Khóa học Chi tiết E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // click Chi tiết for the new course
    const row = page.getByRole("row").filter({ hasText: courseTitle });
    await row.getByRole("link", { name: "Chi tiết" }).click();
    await expect(page.getByRole("heading", { name: courseTitle })).toBeVisible();
    courseUrl = page.url();
  });

  test("shows course info sections", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    await expect(page.getByText("Thông tin chung")).toBeVisible();
    await expect(page.getByText("Trạng thái")).toBeVisible();
    await expect(page.getByText("Nội dung chương")).toBeVisible();
    await expect(page.getByText("Xóa khóa học")).toBeVisible();
  });

  test("edits course title", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    const newTitle = uniqueTitle("Tên Đã Sửa E2E");
    const titleInput = page.getByLabel("Tên khóa học");
    await titleInput.clear();
    await titleInput.fill(newTitle);
    await page.getByRole("button", { name: "Lưu" }).click();
    // page revalidates and heading updates to reflect the saved title
    await expect(page.getByRole("heading", { name: newTitle })).toBeVisible();
  });

  test("adds a module and it appears in the list", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    await page.getByRole("button", { name: "Thêm chương" }).click();
    const moduleName = uniqueTitle("Chương E2E");
    // use placeholder to avoid duplicate id="title" clash with the edit form
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(moduleName)).toBeVisible();
  });

  test("updates course status to published", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    // the status select trigger shows current status text
    const statusTrigger = page.locator("[data-slot='select-trigger']");
    await statusTrigger.click();
    await page.getByRole("option", { name: "Đã xuất bản" }).click();
    // verify the select now shows "Đã xuất bản"
    await expect(statusTrigger).toContainText("Đã xuất bản");
  });

  test("deletes course via danger zone", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    await page.getByRole("button", { name: "Xóa" }).click();
    // confirm dialog
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    // should redirect back to courses list
    await page.waitForURL(new RegExp(`/admin/organizations/${ORG_SLUG}/courses$`));
    await expect(page).toHaveURL(new RegExp(`/admin/organizations/${ORG_SLUG}/courses$`));
  });
});

test.describe("Module management (edit/delete)", () => {
  let courseUrl: string;
  let moduleName: string;

  test.beforeEach(async ({ adminPage: page }) => {
    const courseTitle = uniqueTitle("Khóa học Module E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    await row.getByRole("link", { name: "Chi tiết" }).click();
    await expect(page.getByRole("heading", { name: courseTitle })).toBeVisible();
    courseUrl = page.url();

    // add a module to work with
    moduleName = uniqueTitle("Chương Quản lý E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(moduleName)).toBeVisible();
  });

  test("module name links to module detail page", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    await page.getByRole("link", { name: moduleName }).click();
    await expect(page.getByRole("heading", { name: moduleName })).toBeVisible();
    await expect(page).toHaveURL(/\/modules\//);
  });

  test("renames a module via actions menu", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    const moduleRow = page.locator("div.border").filter({ hasText: moduleName }).last();
    await moduleRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Đổi tên" }).click();
    const newName = uniqueTitle("Chương Đã Đổi Tên E2E");
    await page.getByRole("dialog").getByLabel("Tên chương").clear();
    await page.getByRole("dialog").getByLabel("Tên chương").fill(newName);
    await page.getByRole("dialog").getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(newName)).toBeVisible();
  });

  test("deletes a module via actions menu", async ({ adminPage: page }) => {
    await page.goto(courseUrl);
    const moduleRow = page.locator("div.border").filter({ hasText: moduleName }).last();
    await moduleRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Xóa chương" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await expect(page.getByText(moduleName)).not.toBeVisible();
  });
});

test.describe("Module detail page (lessons)", () => {
  let moduleUrl: string;

  test.beforeEach(async ({ adminPage: page }) => {
    const courseTitle = uniqueTitle("Khóa học Lesson E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    await row.getByRole("link", { name: "Chi tiết" }).click();
    await expect(page.getByRole("heading", { name: courseTitle })).toBeVisible();

    // add a module and navigate to its detail page
    const moduleName = uniqueTitle("Chương Lesson Test");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("link", { name: moduleName }).click();
    await expect(page.getByRole("heading", { name: moduleName })).toBeVisible();
    moduleUrl = page.url();
  });

  test("shows module detail sections", async ({ adminPage: page }) => {
    await page.goto(moduleUrl);
    await expect(page.getByRole("heading", { name: /Bài học/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thêm bài học" })).toBeVisible();
  });

  test("shows empty state when no lessons", async ({ adminPage: page }) => {
    await page.goto(moduleUrl);
    await expect(page.getByText("Chưa có bài học nào")).toBeVisible();
  });

  test("adds a lesson and shows it in the list", async ({ adminPage: page }) => {
    await page.goto(moduleUrl);
    const lessonTitle = uniqueTitle("Bài học E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(lessonTitle)).toBeVisible();
  });

  test("edits a lesson title", async ({ adminPage: page }) => {
    await page.goto(moduleUrl);
    const lessonTitle = uniqueTitle("Bài học Sửa E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
    await lessonRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Chỉnh sửa" }).click();
    const newTitle = uniqueTitle("Bài học Đã Sửa E2E");
    await page.getByRole("dialog").getByLabel("Tên bài học").clear();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(newTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(newTitle)).toBeVisible();
  });

  test("deletes a lesson", async ({ adminPage: page }) => {
    await page.goto(moduleUrl);
    const lessonTitle = uniqueTitle("Bài học Xóa E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
    await lessonRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Xóa bài học" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await expect(page.getByText(lessonTitle)).not.toBeVisible();
  });

  test("back button returns to course detail", async ({ adminPage: page }) => {
    await page.goto(moduleUrl);
    await page.getByRole("link").filter({ hasText: /Chi tiết|Khóa học/ }).first().click();
    await expect(page).not.toHaveURL(/\/modules\//);
  });
});
