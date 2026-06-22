// Re-capture the student learning view with an interaction question visible.
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

async function captureQuestion(browser, name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, isMobile: viewport.isMobile || false });
  await page.goto(`${baseURL}/learn`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  await page.close();
}

(async () => {
  const browser = await launchBrowser();
  await captureQuestion(browser, "sp_baitap_pc", PC);
  await captureQuestion(browser, "sp_baitap_mb", MB);
  await browser.close();
})();
