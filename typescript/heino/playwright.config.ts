import { defineConfig, devices } from "@playwright/test";

try { process.loadEnvFile(".env.test"); } catch {}

export default defineConfig({
  testDir: "./tests",
  // File-level parallelism: fullyParallel=false keeps tests WITHIN a file serial
  // (so a file's beforeAll-created data is shared safely by its own tests), while
  // different files run concurrently across `workers`. Every spec is self-isolating
  // (it creates its own unique users/courses/lessons via fixtures helpers and never
  // mutates shared seed entities), so this is race-free. Plain `playwright test`
  // is therefore parallel with no CLI flags — do not pass --workers/--project.
  // workers is capped at 4 because the local Whisper (speaches) service serializes
  // transcriptions (whisper_max_concurrent=1), so higher worker counts only queue
  // at that bottleneck without speeding the AI-heavy specs up.
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
