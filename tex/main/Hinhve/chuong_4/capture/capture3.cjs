// Capture analytics screens used in chapter 4.
const path = require("node:path");
let browsers;
try {
  browsers = require("playwright");
} catch {
  browsers = require("@playwright/test");
}
const { chromium, firefox } = browsers;

const outDir = path.resolve(__dirname, "..");
const baseURL = process.env.BASE_URL || "http://caddy";
const PC = { width: 1440, height: 1000 };
const MB = { width: 390, height: 1200, isMobile: true };

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await firefox.launch();
  }
}

async function captureAnalytics(browser, name, pathName, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, isMobile: viewport.isMobile || false });
  await page.goto(`${baseURL}${pathName}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  await page.close();
}

(async () => {
  const browser = await launchBrowser();
  await captureAnalytics(browser, "sp_heatmap_pc", "/dashboard/heatmap", PC);
  await captureAnalytics(browser, "sp_heatmap_mb", "/dashboard/heatmap", MB);
  await captureAnalytics(browser, "sp_ketqua_pc", "/dashboard/results", PC);
  await captureAnalytics(browser, "sp_ketqua_mb", "/dashboard/results", MB);
  await browser.close();
})();
