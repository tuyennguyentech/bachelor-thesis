/**
 * E2E tests for dashboard course management by org members.
 *
 * hust-cs seed roles:
 *   alice  = admin  (userPage)
 *   carol  = teacher (teacherPage)
 *   bob    = student (studentPage)
 *
 * Management controls (create / edit / add module / add lesson / delete) should
 * be visible to admin and teacher, hidden from student.
 */

import { test, expect } from "../fixtures";

const ORG_SLUG = "hust-cs";
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;

function uid(base: string) {
  return `${base} ${Date.now()}`;
}

// ── Visibility ────────────────────────────────────────────────────────────────

test.describe("Manage button visibility on courses list", () => {
  test("admin sees Tạo khóa học button", async ({ userPage: page }) => {
    await page.goto(COURSES_URL);
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).toBeVisible();
  });

  test("teacher sees Tạo khóa học button", async ({ teacherPage: page }) => {
    await page.goto(COURSES_URL);
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).toBeVisible();
  });

  test("student does not see Tạo khóa học button", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL);
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).not.toBeVisible();
  });
});

// ── Teacher full lifecycle ────────────────────────────────────────────────────

test.describe("Teacher course lifecycle", () => {
  let courseTitle: string;
  let courseUrl: string;

  test.beforeEach(async ({ teacherPage: page }) => {
    courseTitle = uid("Khóa học Giáo viên E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("cell", { name: courseTitle })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    // read href from the chevron link (Firefox asChild+Link can be flaky with click-navigate)
    const href = await row.getByRole("link").getAttribute("href");
    courseUrl = `${href}`;
    await page.goto(courseUrl);
    await expect(page.getByRole("heading", { name: courseTitle })).toBeVisible();
  });

  test("course detail shows management sections for teacher", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    await expect(page.getByText("Thông tin chung")).toBeVisible();
    await expect(page.getByText("Trạng thái")).toBeVisible();
    await expect(page.getByText("Nội dung")).toBeVisible();
    // teacher cannot change status or delete
    await expect(page.locator("[data-slot='select-trigger']")).not.toBeVisible();
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();
  });

  test("edits course title", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    const newTitle = uid("Tên Sửa Giáo viên E2E");
    const titleInput = page.getByLabel("Tên khóa học");
    await titleInput.clear();
    await titleInput.fill(newTitle);
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByRole("heading", { name: newTitle })).toBeVisible();
  });

  test("adds a module", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    await page.getByRole("button", { name: "Thêm chương" }).click();
    const moduleName = uid("Chương Giáo viên E2E");
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(moduleName)).toBeVisible();
  });

  test("renames a module", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    const moduleName = uid("Chương Đổi Tên E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // open module actions dropdown
    const moduleHeader = page.locator("[class*='bg-muted']").filter({ hasText: moduleName });
    await moduleHeader.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Đổi tên" }).click();

    const newName = uid("Chương Đã Đổi Tên E2E");
    await page.getByRole("dialog").getByLabel("Tên chương").clear();
    await page.getByRole("dialog").getByLabel("Tên chương").fill(newName);
    await page.getByRole("dialog").getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(newName)).toBeVisible();
  });

  test("deletes a module", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    const moduleName = uid("Chương Xóa E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const moduleHeader = page.locator("[class*='bg-muted']").filter({ hasText: moduleName });
    await moduleHeader.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Xóa chương" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await expect(page.getByText(moduleName)).not.toBeVisible();
  });

  test("adds a lesson to a module", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    const moduleName = uid("Chương Bài học E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học Giáo viên E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(lessonTitle)).toBeVisible();
  });

  test("edits a lesson", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    const moduleName = uid("Chương Sửa Bài học E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học Sửa E2E");
    await page.getByRole("button", { name: "Thêm bài học" }).click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // open lesson actions dropdown
    const lessonRow = page.locator("div.border").filter({ hasText: lessonTitle }).last();
    await lessonRow.getByRole("button").click();
    await page.getByRole("menuitem", { name: "Chỉnh sửa" }).click();
    const newTitle = uid("Bài học Đã Sửa E2E");
    await page.getByRole("dialog").getByLabel("Tên bài học").clear();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(newTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(newTitle)).toBeVisible();
  });

  test("deletes a lesson", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    const moduleName = uid("Chương Xóa Bài học E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học Xóa E2E");
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

  test("teacher cannot delete course", async ({ teacherPage: page }) => {
    await page.goto(courseUrl);
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();
  });
});

// ── Admin course status and delete ───────────────────────────────────────────

test.describe("Admin course status and delete", () => {
  let courseUrl: string;

  test.beforeEach(async ({ userPage: page }) => {
    const courseTitle = uid("Khóa học Admin E2E");
    await page.goto(COURSES_URL);
    await page.getByRole("button", { name: "Tạo khóa học" }).click();
    await page.getByLabel("Tên khóa học").fill(courseTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Tạo" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("cell", { name: courseTitle })).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: courseTitle });
    const href = await row.getByRole("link").getAttribute("href");
    courseUrl = `${href}`;
    await page.goto(courseUrl);
    await expect(page.getByRole("heading", { name: courseTitle })).toBeVisible();
  });

  test("admin sees status select and delete button", async ({ userPage: page }) => {
    await page.goto(courseUrl);
    await expect(page.locator("[data-slot='select-trigger']")).toBeVisible();
    await expect(page.getByText("Xóa khóa học")).toBeVisible();
  });

  test("changes course status to published and persists after reload", async ({ userPage: page }) => {
    await page.goto(courseUrl);
    const statusTrigger = page.locator("[data-slot='select-trigger']");
    await statusTrigger.click();
    await page.getByRole("option", { name: "Đã xuất bản" }).click();
    await expect(statusTrigger).toContainText("Đã xuất bản");
    // wait for the server action to finish (select re-enables when transition completes)
    await expect(statusTrigger).not.toBeDisabled();
    await page.goto(courseUrl);
    await expect(page.locator("[data-slot='select-trigger']")).toContainText("Đã xuất bản");
  });

  test("deletes course and redirects to courses list", async ({ userPage: page }) => {
    await page.goto(courseUrl);
    await page.getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await page.waitForURL(new RegExp(`/dashboard/organizations/${ORG_SLUG}/courses$`));
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${ORG_SLUG}/courses$`));
  });
});

// ── Student cannot manage ─────────────────────────────────────────────────────

test.describe("Student course detail (read-only)", () => {
  // Uses seeded courses — no need to create one, avoids two-fixture conflict.
  test("student does not see management controls on course detail", async ({
    studentPage: page,
  }) => {
    await page.goto(COURSES_URL);
    // navigate to the first seeded course via the chevron link
    const href = await page.getByRole("row").nth(1).getByRole("link").getAttribute("href");
    await page.goto(`${href}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // student should NOT see management controls
    await expect(page.getByText("Thông tin chung")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Thêm chương" })).not.toBeVisible();
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();
    // content section is still visible (read-only) — use heading role to avoid strict-mode match
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
  });
});
