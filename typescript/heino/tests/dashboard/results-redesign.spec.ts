/**
 * E2E — redesigned course-results page: 3 sub-tabs + interactive charts.
 * Accuracy (numbers match the seed) + display + edge cases. Navigates by course
 * title search so it survives reseeds (lesson/course IDs change each reset).
 */
import { test, expect, loginAs } from "../fixtures";
import type { Page } from "@playwright/test";

const OOP = "Lập trình hướng đối tượng với Java"; // hust-cs, 10 attempters
const EMPTY = "Cơ sở dữ liệu"; // hust-cs, 0 attempters
const LANGLAB_SMALL = "Ngữ học ứng dụng"; // langlab, 5 attempters (<6)

/** Search a course by title in an org and open its ?tab=results. */
async function gotoResults(page: Page, org: string, title: string) {
  await page.goto(`/dashboard/organizations/${org}/courses?q=${encodeURIComponent(title)}`, {
    waitUntil: "domcontentloaded",
  });
  const card = page.locator('[data-slot="card"]').filter({ hasText: title }).first();
  const href = await card.getByRole("link").first().getAttribute("href");
  if (!href) throw new Error(`Course "${title}" link not found`);
  await page.goto(`${href.split("?")[0].replace(/\/$/, "")}?tab=results`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("Kết quả học viên")).toBeVisible({ timeout: 20000 });
}

test.use({ viewport: { width: 1380, height: 1000 } });

test.describe("Course results — redesigned tabs + charts", () => {
  test("histogram bin counts match the seed distribution (0/2/2/4/2) + avg footer", async ({ page, baseURL }) => {
    await loginAs(page, "frank@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "hust-cs", OOP);
    await page.getByTestId("results-subtab-distribution").click();
    const hist = page.getByTestId("score-distribution");
    await expect(hist).toBeVisible();
    await expect(hist.getByText("4", { exact: true }).first()).toBeVisible();
    for (const b of ["0–19", "20–39", "40–59", "60–79", "80–100"]) {
      await expect(hist.getByText(b, { exact: true })).toBeVisible();
    }
    await expect(hist.getByText(/10 học viên có bài làm/)).toBeVisible();
    await expect(hist.getByText("62%")).toBeVisible();
  });

  test("histogram bar hover shows count + class %", async ({ page, baseURL }) => {
    await loginAs(page, "frank@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "hust-cs", OOP);
    await page.getByTestId("results-subtab-distribution").click();
    const hist = page.getByTestId("score-distribution");
    // Band 3 = 60–79 holds 4 of 10 = 40%. force: the hit rect sits behind the bar.
    await hist.locator('rect[data-band="3"]').hover({ force: true });
    await expect(hist.getByText(/4 học viên · 40% lớp/)).toBeVisible({ timeout: 5000 });
  });

  test("scatter groups coincident students into sized bubbles", async ({ page, baseURL }) => {
    await loginAs(page, "frank@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "hust-cs", OOP);
    await page.getByTestId("results-subtab-scatter").click();
    const scatter = page.getByTestId("engagement-scatter");
    await expect(scatter).toBeVisible();
    // 10 students collapse to 8 bubbles: iris+carol (74,73%) and quinn+noah (82,82%) tie.
    await expect(scatter.locator("circle[data-dot]")).toHaveCount(8);
    // At least one bubble holds 2 learners.
    await expect(scatter.locator('circle[data-dot][data-count="2"]').first()).toBeVisible();

    // Hover the tie bubble → tooltip says "2 học viên cùng vị trí" + lists both.
    await scatter.locator('circle[data-dot][data-count="2"]').first().hover();
    await expect(scatter.getByText(/2 học viên cùng vị trí/)).toBeVisible({ timeout: 5000 });
  });

  test("scatter tooltip shows accurate score + engagement (Peter in danger zone)", async ({ page, baseURL }) => {
    await loginAs(page, "frank@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "hust-cs", OOP);
    await page.getByTestId("results-subtab-scatter").click();
    const scatter = page.getByTestId("engagement-scatter");
    const dots = scatter.locator("circle[data-dot]");
    const n = await dots.count();
    let peter = "";
    for (let i = 0; i < n; i++) {
      await dots.nth(i).hover();
      const tip = scatter.getByText(/Điểm:/).first();
      if (await tip.isVisible().catch(() => false)) {
        const txt = (await tip.textContent()) ?? "";
        if (txt.includes("27%")) peter = txt;
      }
    }
    expect(peter, "Peter's tooltip seen").toBeTruthy();
    expect(peter).toMatch(/Điểm: 27%/);
    expect(peter).toMatch(/Tương tác: 31/);
  });

  test("switching to Tổng does not break the chart tabs", async ({ page, baseURL }) => {
    await loginAs(page, "frank@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "hust-cs", OOP);
    await page.getByTestId("results-subtab-scatter").click();
    await expect(page.getByTestId("engagement-scatter")).toBeVisible();
    await page.getByTestId("results-mode-total").click();
    await expect(page.getByTestId("engagement-scatter")).toBeVisible();
    await expect(page.getByTestId("engagement-scatter").locator("circle[data-dot]")).toHaveCount(8);
  });

  test("small cohort (<6) shows a reference note but still renders the scatter", async ({ page, baseURL }) => {
    await loginAs(page, "linh@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "langlab", LANGLAB_SMALL);
    await page.getByTestId("results-subtab-scatter").click();
    const scatter = page.getByTestId("engagement-scatter");
    await expect(scatter).toBeVisible();
    await expect(scatter.getByText(/Lớp còn ít học viên/)).toBeVisible();
    const dots = scatter.locator("circle[data-dot]");
    const count = await dots.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5); // ≤ 5 students (grouping may collapse ties)
  });

  test("empty course (0 attempters) shows empty state, no sub-tabs", async ({ page, baseURL }) => {
    // frank owns "Cơ sở dữ liệu" (no attempts), so it appears in his course list.
    await loginAs(page, "frank@dyadia.local", "Password123!", baseURL);
    await gotoResults(page, "hust-cs", EMPTY);
    await expect(page.getByTestId("results-subtab-distribution")).toHaveCount(0);
    await expect(page.getByTestId("score-distribution")).toHaveCount(0);
    await expect(page.getByTestId("engagement-scatter")).toHaveCount(0);
    await expect(page.getByText("Chưa có dữ liệu")).toBeVisible();
  });
});
