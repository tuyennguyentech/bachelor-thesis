/**
 * E2E tests — course list lock indicator and access control.
 *
 * The courses list page (/dashboard/organizations/hust-cs/courses) renders a
 * CARD-BASED layout (redesigned from the old table layout) with two sections:
 *
 *   Section 1 — "Khóa học của bạn":
 *     - Enrolled/accessible courses get a card with:
 *         - Badge "Đang tham gia" in footer
 *         - Button/Link "Vào học" (student) or "Quản lý" (manager)
 *
 *   Section 2 — "Khóa học khác trong tổ chức" (courses the viewer has NOT joined):
 *     - Plain member (no bypass): locked card — "Chưa tham gia" footer badge,
 *       "Yêu cầu tham gia" header badge + link (navigates to the lock screen).
 *     - Manager (course owner / org owner-admin): a JOINABLE card with an instant
 *       "Tham gia" self-join button (data-testid="card-join"). Org owners/admins
 *       are NOT auto-enrolled in every course — they self-join at will, no approval.
 *
 * Sectioning is by ACTUAL membership (course_members row), NOT bypass access.
 *
 * Bob (studentPage) is enrolled in "Cấu trúc dữ liệu và Giải thuật" (DSA)
 * but NOT enrolled in at least one other hust-cs course.
 *
 * Alice (userPage) is org ADMIN. She is seeded as a member of SOME hust-cs courses
 * (e.g. DSA → "Vào học" + "Vào quản lý") but NOT others (e.g. "Hệ điều hành" →
 * "Tham gia"), so BOTH sections render for her. She also sees "Tạo khóa học".
 */

import {
  test,
  expect,
  SEED_HUST_CS_SLUG,
  SEED_DSA_COURSE_TITLE,
  SEED_HUST_CS_COURSE_ALICE_NOT_JOINED,
  SEED_HUST_CS_COURSE_ALICE_NOT_JOINED_2,
} from "../fixtures";

const COURSES_URL = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;

// ── Student sees enrolled course in "Khóa học của bạn" section ────────────

test.describe("Course list — enrolled course (studentPage = bob)", () => {
  test("'Khóa học của bạn' section heading is visible", async ({ studentPage: page }) => {
    // Use ?q= to filter for the DSA course bob is enrolled in.
    // Without filtering, page 1 may not contain older seeded courses when there are 42+ courses.
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Khóa học của bạn" })).toBeVisible();
  });

  test("enrolled DSA course card shows 'Đang tham gia' badge", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();

    // The card for DSA should show "Đang tham gia" badge
    const dsaCard = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    await expect(dsaCard).toBeVisible();
    await expect(dsaCard.getByText("Đang tham gia")).toBeVisible();
  });

  test("enrolled DSA course card has a 'Vào học' link (not disabled)", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );

    // The accessible card footer has a "Vào học" / "Tiếp tục học" link for students.
    // CTA label is progress-aware: "Tiếp tục học" once the student has started, else "Vào học".
    const vaoHocLink = page.getByRole("link", { name: /Vào học|Tiếp tục học/ }).first();
    await expect(vaoHocLink).toBeVisible();
    const href = await vaoHocLink.getAttribute("href");
    expect(href).toMatch(/\/courses\//);
  });

  test("clicking 'Vào học' navigates to the course workspace", async ({ studentPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const vaoHocLink = page.getByRole("link", { name: /Vào học|Tiếp tục học/ }).first();
    const href = await vaoHocLink.getAttribute("href");
    await page.goto(href!, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: SEED_DSA_COURSE_TITLE })).toBeVisible();
  });
});

// ── Student sees locked courses in "Khóa học khác trong tổ chức" section ──

test.describe("Course list — locked course cards (studentPage = bob)", () => {
  test("'Khóa học khác trong tổ chức' section is visible with locked courses", async ({ studentPage: page }) => {
    // Load all courses in hust-cs (no search filter — show everything)
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // The locked section heading should be visible
    await expect(
      page.getByRole("heading", { name: "Khóa học khác trong tổ chức" }),
    ).toBeVisible();
  });

  test("locked course card shows 'Chưa tham gia' badge", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // At least one card in the locked section carries the "Chưa tham gia" badge
    const lockedBadge = page.getByText("Chưa tham gia").first();
    await expect(lockedBadge).toBeVisible();
  });

  test("locked course card shows 'Yêu cầu tham gia' header badge", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // Locked cards have a "Yêu cầu tham gia" badge in their header area
    await expect(page.getByText("Yêu cầu tham gia").first()).toBeVisible();
  });

  test("locked course card has a 'Yêu cầu tham gia' link (navigates to lock screen)", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // The locked card footer has a "Yêu cầu tham gia" link (not a disabled button)
    const requestLink = page.getByTestId("card-request-join").first();
    await expect(requestLink).toBeVisible();

    // It should link to a course detail page
    const href = await requestLink.getAttribute("href");
    expect(href).toMatch(/\/courses\//);
  });

  test("clicking 'Yêu cầu tham gia' on locked course navigates to the course lock screen", async ({ studentPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });

    // Navigate using href to avoid Radix/Firefox flakiness
    const requestLink = page.getByTestId("card-request-join").first();
    const href = await requestLink.getAttribute("href");
    await page.goto(href!, { waitUntil: "domcontentloaded" });

    // Should land on the course lock screen
    // "Khóa học đang bị khóa" is rendered as a CardTitle (generic element, not a heading role)
    await expect(
      page.getByText("Khóa học đang bị khóa"),
    ).toBeVisible();
  });
});

// ── Manager (userPage = alice, org ADMIN) — JOINED course ────────────────────

test.describe("Course list — manager joined course (userPage = alice)", () => {
  test("admin alice sees 'Tạo khóa học' button (canManage)", async ({ userPage: page }) => {
    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Tạo khóa học" })).toBeVisible();
  });

  test("joined DSA card shows split CTA 'Vào học' + 'Vào quản lý'", async ({ userPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    await expect(card).toBeVisible();
    // alice is a manager-MEMBER of DSA → learn + manage CTAs.
    await expect(card.getByTestId("card-learn")).toBeVisible();
    await expect(card.getByRole("link", { name: /Vào quản lý/ })).toBeVisible();
  });

  test("joined DSA card is badged 'Quản lý', NOT 'Tham gia'/'Đang tham gia'", async ({ userPage: page }) => {
    await page.goto(
      `${COURSES_URL}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`,
      { waitUntil: "domcontentloaded" },
    );
    const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
    await expect(card).toBeVisible();
    // Manager-member: badged "Quản lý". Not a learner ("Đang tham gia"), and
    // since she has already joined there is no self-join ("Tham gia") affordance.
    await expect(card.getByText("Quản lý", { exact: true }).first()).toBeVisible();
    await expect(card.getByText("Đang tham gia")).not.toBeVisible();
    await expect(card.getByTestId("card-join")).toHaveCount(0);
  });
});

// ── Manager (userPage = alice) — NOT-joined course shows "Tham gia" ──────────

test.describe("Course list — manager not-joined course (userPage = alice)", () => {
  const COURSES_URL_NJ = `${COURSES_URL}?q=${encodeURIComponent(SEED_HUST_CS_COURSE_ALICE_NOT_JOINED)}`;

  test("alice DOES see 'Khóa học khác trong tổ chức' (she is not in every course)", async ({ userPage: page }) => {
    await page.goto(COURSES_URL_NJ, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Khóa học", exact: true })).toBeVisible();
    // Membership-based sectioning: a course alice has NOT joined surfaces here,
    // even though she bypasses access as org admin.
    await expect(
      page.getByRole("heading", { name: "Khóa học khác trong tổ chức" }),
    ).toBeVisible();
  });

  test("not-joined card shows a 'Tham gia' self-join button (no approval)", async ({ userPage: page }) => {
    await page.goto(COURSES_URL_NJ, { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="card"]').filter({ hasText: SEED_HUST_CS_COURSE_ALICE_NOT_JOINED }).first();
    await expect(card).toBeVisible();
    const joinBtn = card.getByTestId("card-join");
    await expect(joinBtn).toBeVisible();
    await expect(joinBtn).toHaveText(/Tham gia/);
    // She is NOT a member yet → no learn/manage CTA. And she is a manager, so this
    // is a direct self-join, NOT the plain-member "Yêu cầu tham gia" request flow.
    await expect(card.getByTestId("card-manage")).toHaveCount(0);
    await expect(card.getByTestId("card-request-join")).toHaveCount(0);
    await expect(card.getByText("Đang tham gia")).not.toBeVisible();
  });
});

// ── Manager (userPage = alice) — self-join lifecycle (mutation + cleanup) ────

test.describe("Course list — manager self-join lifecycle (userPage = alice)", () => {
  // Uses a SECOND not-joined course so it never collides with the read-only
  // assertions above. try/finally removes the freshly-created membership so the
  // seed stays clean for retries and parallel files.
  const COURSE = SEED_HUST_CS_COURSE_ALICE_NOT_JOINED_2;
  const LIST_URL = `${COURSES_URL}?q=${encodeURIComponent(COURSE)}`;

  test("clicking 'Tham gia' enrolls alice → card flips to Vào học + Vào quản lý", async ({ userPage: page }) => {
    // Multi-step (self-join → app-driven reload → cleanup); allow headroom for a cold backend.
    test.setTimeout(90_000);
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-slot="card"]').filter({ hasText: COURSE }).first();
    await expect(card.getByTestId("card-join")).toBeVisible();

    let manageHref: string | null = null;
    try {
      // Click self-join and let the APP drive the outcome — the test does NOT reload
      // the page itself. The button enrols then reloads the list; the card must
      // re-section into "Khóa học của bạn" with the manage CTA on its own.
      //
      // Regression guard: the old button relied on a soft router.refresh() inside the
      // click's useTransition. When that refresh did not settle, the button stuck on
      // "Đang tham gia…" forever and the card never flipped. Asserting the flip with
      // NO manual reload here would have hung — exactly the reported bug.
      await card.getByTestId("card-join").click();
      const joined = page.locator('[data-slot="card"]').filter({ hasText: COURSE }).first();
      await expect(joined.getByTestId("card-manage")).toBeVisible({ timeout: 45000 });
      // Now a member: split manage/learn CTA, badged "Quản lý", no self-join button.
      await expect(joined.getByTestId("card-learn")).toBeVisible();
      await expect(joined.getByText("Quản lý", { exact: true })).toBeVisible();
      await expect(joined.getByTestId("card-join")).toHaveCount(0);
      manageHref = await joined.getByTestId("card-manage").getAttribute("href");
    } finally {
      // Cleanup: remove alice's freshly-created membership via the members tab.
      try {
        if (!manageHref) {
          await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
          manageHref = await page
            .locator('[data-slot="card"]').filter({ hasText: COURSE }).first()
            .getByTestId("card-manage").getAttribute("href").catch(() => null);
        }
        if (manageHref) {
          await page.goto(manageHref.split("?")[0] + "?tab=members", { waitUntil: "domcontentloaded" });
          const managers = page.getByTestId("members-group-managers");
          const aliceRow = managers.getByRole("row").filter({ hasText: "alice@dyadia.local" });
          if (await aliceRow.count()) {
            await aliceRow.getByRole("button", { name: "Mở menu thao tác thành viên" }).click();
            await page.getByRole("menuitem", { name: "Xóa khỏi khóa học" }).click();
            await page.getByRole("button", { name: "Xóa", exact: true }).click();
            await expect(managers.getByText("alice@dyadia.local")).not.toBeVisible({ timeout: 10000 });
          }
        }
      } catch {
        // Best-effort cleanup; a fresh reseed precedes the next full run regardless.
      }
    }
  });
});
