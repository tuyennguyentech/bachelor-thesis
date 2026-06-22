const path = require("node:path");
const { execFileSync } = require("node:child_process");
let browsers;
try {
  browsers = require("playwright");
} catch {
  browsers = require("@playwright/test");
}
const { chromium, firefox } = browsers;

const root = __dirname;
const outputDir = path.resolve(root, "..");
const pages = [
  ["gd_hocbai.html", "gd_hocbai.pdf"],
  ["gd_quanly.html", "gd_quanly.pdf"],
  ["gd_tiendo.html", "gd_tiendo.pdf"],
];

async function launchBrowser() {
  try {
    const browser = await chromium.launch();
    return { browser, pdf: true };
  } catch {
    const browser = await firefox.launch();
    return { browser, pdf: false };
  }
}

(async () => {
  const { browser, pdf } = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });

  for (const [source, target] of pages) {
    await page.goto(`file://${path.join(root, source)}`, { waitUntil: "networkidle" });
    const out = path.join(outputDir, target);
    if (pdf) {
      await page.pdf({
        path: out,
        width: "1280px",
        height: "720px",
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
    } else {
      const png = out.replace(/\.pdf$/i, ".png");
      await page.screenshot({ path: png, fullPage: false });
      if (process.env.MOCKUP_SCREENSHOT_ONLY !== "1") {
        execFileSync("magick", [png, out]);
      }
    }
  }

  await browser.close();
})();
