import { defineConfig, devices } from "@playwright/test";

try { process.loadEnvFile(".env.test"); } catch {}

export default defineConfig({
  testDir: "./tests",
  // File-level parallelism: with fullyParallel=false, `workers` files run concurrently
  // but tests WITHIN a file stay serial. This is the proven-green config (348/348).
  // The test suite was hardened for higher parallelism (uid()-isolated data, .serial on
  // shared-state describes, seeded AI setup via createAnalyzedLesson instead of real
  // Whisper), but per-test fullyParallel at workers:8 overloaded the single dev
  // richter+heino (beforeEach UI flows timed out under 8 concurrent browser sessions).
  // True per-test max parallelism needs multiple richter+heino LANES (separate port/DB
  // per shard), not just more workers on one instance — tracked as a follow-up.
  fullyParallel: false,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: process.env.CI
    ? {
        command: "pnpm start",
        url: "http://localhost:3000",
        reuseExistingServer: false,
      }
    : undefined,
});
