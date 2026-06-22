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

import {
  test,
  expect,
  uid,
  createCourse,
  getTeacherAuth,
  getOrgId,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
} from "../fixtures";

const ORG_SLUG = "hust-cs";
const COURSES_URL = `/dashboard/organizations/${ORG_SLUG}/courses`;

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

// .serial: all tests share a single course created once via the API in
// beforeAll and mutate it (modules/lessons/title) across siblings, so they must
// run in order. Per-test module/lesson creation stays inside each test.
test.describe.serial("Teacher course lifecycle", () => {
  let courseTitle: string;
  let courseUrl: string;

  test.beforeAll(async ({ baseURL }) => {
    // Create the shared course via the richter API (no UI clicking) — the
    // create-course UI flow is covered separately by "Admin course status and
    // delete" / visibility tests. carol (teacherPage) owns it so all the
    // teacher-management tests can mutate it.
    courseTitle = uid("Khóa học Giáo viên E2E");
    const { token, userId: carolId } = await getTeacherAuth(baseURL);
    const orgId = await getOrgId(token, SEED_HUST_CS_SLUG, baseURL);
    const courseId = await createCourse(token, orgId, courseTitle, carolId, baseURL);
    courseUrl = `${COURSES_URL}/${courseId}`;
  });

  test("course detail shows management sections for teacher", async ({ teacherPage: page }) => {
    // Overview tab: Thông tin chung + Trạng thái
    await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Thông tin chung")).toBeVisible();
    await expect(page.getByText("Trạng thái")).toBeVisible();
    // teacher cannot change status or delete
    await expect(page.locator("[data-slot='select-trigger']")).not.toBeVisible();
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();
    // Lessons tab: Nội dung section
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
  });

  test("edits course title", async ({ teacherPage: page }) => {
    await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
    const newTitle = uid("Tên Sửa Giáo viên E2E");
    const titleInput = page.getByLabel("Tên khóa học");
    await expect(titleInput).toBeEnabled({ timeout: 15000 });
    await titleInput.clear();
    await titleInput.fill(newTitle);
    // Click only after the Save button hydrates (a disabled click is a no-op, so the
    // save never fires), and wait for the UpdateCourse RPC response as the commit
    // signal — deterministic, unlike the "Đã lưu" message which is cleared when
    // router.refresh() remounts the title-keyed form. Then re-render from the server.
    const save = page.getByRole("button", { name: "Lưu" });
    await expect(save).toBeEnabled({ timeout: 15000 });
    const resp = page.waitForResponse(
      (r) => r.url().includes("UpdateCourse") && r.request().method() === "POST",
      { timeout: 20000 },
    );
    await save.click();
    expect((await resp).ok(), "UpdateCourse response ok").toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: newTitle })).toBeVisible({ timeout: 15000 });
  });

  test("adds a module", async ({ teacherPage: page }) => {
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Thêm chương" }).click();
    const moduleName = uid("Chương Giáo viên E2E");
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(moduleName)).toBeVisible();
  });

  test("renames a module", async ({ teacherPage: page }) => {
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
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
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
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
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
    const moduleName = uid("Chương Bài học E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học Giáo viên E2E");
    // The .serial course accumulates modules; target the just-created module's button (last).
    await page.getByRole("button", { name: "Thêm bài học" }).last().click();
    await page.getByRole("dialog").getByLabel("Tên bài học").fill(lessonTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText(lessonTitle)).toBeVisible();
  });

  test("edits a lesson", async ({ teacherPage: page }) => {
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
    const moduleName = uid("Chương Sửa Bài học E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học Sửa E2E");
    // The .serial course accumulates modules; target the just-created module's button (last).
    await page.getByRole("button", { name: "Thêm bài học" }).last().click();
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
    await page.goto(`${courseUrl}?tab=lessons`, { waitUntil: "domcontentloaded" });
    const moduleName = uid("Chương Xóa Bài học E2E");
    await page.getByRole("button", { name: "Thêm chương" }).click();
    await page.getByRole("dialog").getByPlaceholder("VD: Chương 1: Giới thiệu").fill(moduleName);
    await page.getByRole("dialog").getByRole("button", { name: "Thêm" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const lessonTitle = uid("Bài học Xóa E2E");
    // The .serial course accumulates modules; target the just-created module's button (last).
    await page.getByRole("button", { name: "Thêm bài học" }).last().click();
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
    await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
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
    // The new course appears as a card in "Khóa học của bạn"; search by title to
    // avoid pagination hiding the freshly created course.
    await page.goto(`${COURSES_URL}?q=${encodeURIComponent(courseTitle)}`, { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="card"]').filter({ hasText: courseTitle }).first();
    await expect(card).toBeVisible();
    const href = await card.getByRole("link").first().getAttribute("href");
    courseUrl = `${href}`;
    await page.goto(courseUrl);
    await expect(page.getByRole("heading", { name: courseTitle })).toBeVisible();
  });

  test("admin sees status select and delete button", async ({ userPage: page }) => {
    await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-slot='select-trigger']")).toBeVisible();
    await expect(page.getByText("Xóa khóa học")).toBeVisible();
  });

  test("changes course status to published and persists after reload", async ({ userPage: page }) => {
    await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
    const statusTrigger = page.locator("[data-slot='select-trigger']");
    await expect(statusTrigger).toBeEnabled({ timeout: 15000 });
    await statusTrigger.click();
    await page.getByRole("option", { name: "Đã xuất bản" }).click();
    await expect(statusTrigger).toContainText("Đã xuất bản");
    // Verify persistence by re-rendering from the server until the status sticks. The
    // status select is server-rendered, so each goto reflects the committed value at
    // domcontentloaded. The toPass loop absorbs the RPC commit latency and any
    // in-flight soft refresh — far more robust than gating on the select re-enabling,
    // which is tied to the heavy overview page's router.refresh() and lagged past
    // fixed timeouts under load.
    await expect(async () => {
      await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-slot='select-trigger']")).toContainText("Đã xuất bản", { timeout: 4000 });
    }).toPass({ timeout: 25000 });
  });

  test("deletes course and redirects to courses list", async ({ userPage: page }) => {
    await page.goto(`${courseUrl}?tab=overview`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Xóa" }).click();
    await page.waitForURL(new RegExp(`/dashboard/organizations/${ORG_SLUG}/courses$`));
    await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${ORG_SLUG}/courses$`));
  });
});

// ── Student cannot manage ─────────────────────────────────────────────────────

test.describe("Student course detail (read-only)", () => {
  // Uses the seeded DSA course — bob is a course member so the row has a link (not a disabled button).
  test("student does not see management controls on course detail", async ({
    studentPage: page,
  }) => {
    // Use ?q= search so we land on the seeded course regardless of pagination order.
    await page.goto(`${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    const href = await card.getByRole("link").first().getAttribute("href");

    // Overview tab: no management controls
    await page.goto(`${href}?tab=overview`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Thông tin chung")).not.toBeVisible();
    await expect(page.getByText("Xóa khóa học")).not.toBeVisible();

    // Lessons tab: content visible but no Thêm chương button
    await page.goto(`${href}?tab=lessons`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Thêm chương" })).not.toBeVisible();
    // content section is still visible (read-only) — use heading role to avoid strict-mode match
    await expect(page.getByRole("heading", { name: /Nội dung/ })).toBeVisible();
  });
});
