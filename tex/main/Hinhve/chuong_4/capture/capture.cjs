// Capture primary product screens. Run from repo root through the heino container:
// ./scripts/setup/environment.dev/container-shell.sh heino -- node tex/main/Hinhve/chuong_4/capture/capture.cjs
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

async function capturePage(browser, name, url, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, isMobile: viewport.isMobile || false });
  await page.goto(new URL(url, baseURL).toString(), { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  await page.close();
}

(async () => {
  const browser = await launchBrowser();
  await capturePage(browser, "sp_taonhanh_pc", "/dashboard", PC);
  await capturePage(browser, "sp_xulyai_pc", "/dashboard", PC);
  await capturePage(browser, "sp_hocbai_pc", "/learn", PC);
  await capturePage(browser, "sp_hocbai_mb", "/learn", MB);
  await capturePage(browser, "sp_ketqua_pc", "/dashboard/results", PC);
  await capturePage(browser, "sp_ketqua_mb", "/dashboard/results", MB);
  await browser.close();
})();
